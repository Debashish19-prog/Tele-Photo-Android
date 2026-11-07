package app.telephoto

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.WindowInsets
import android.webkit.WebChromeClient
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import android.widget.FrameLayout
import android.widget.Toast

/** The screen. It only shows the page, which belongs to EngineHost and outlives this. */
class MainActivity : Activity() {
    private lateinit var root: FrameLayout
    private var backCallback: Any? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = FrameLayout(this)
        // From Android 15, the app is drawn under the system bars, so the page is kept clear of them here.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            root.setOnApplyWindowInsetsListener { view, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                WindowInsets.CONSUMED
            }
        }
        setContentView(root)
        // From Android 16, this is the only way to hear about Back in an app built for that version.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            backCallback = OnBackInvokedCallback { goBack() }
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback as OnBackInvokedCallback)
        }
        reattach()
        SyncNotifications.dismissAttention(this)
        SyncScheduler.arm(this)
    }

    fun reattach() {
        val view = EngineHost.attach(this)
        root.removeAllViews()
        root.addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    }

    override fun onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            (backCallback as? OnBackInvokedCallback)?.let { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it) }
        }
        EngineHost.detach(this)
        super.onDestroy()
    }

    /** Only reached below Android 13. Everything newer uses the callback set up in onCreate. */
    @SuppressLint("GestureBackNavigation")
    @Deprecated("Still what Android 10 to 12 call.")
    override fun onBackPressed() = goBack()

    /** Leaving by Back keeps the app in memory, so coming back to it is instant. */
    private fun goBack() {
        EngineHost.back { moveTaskToBack(true) }
    }

    fun requestGalleryAccess() {
        requestPermissions(Gallery.neededPermissions(), REQUEST_GALLERY)
    }

    @Deprecated("Part of the plain Activity API, which is all this app uses.")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_GALLERY) return
        EngineHost.accessChanged()
        // Asked straight after, as this is what lets a large backup finish with the app closed.
        if (Gallery.access(this) != "none" && !SyncScheduler.isBatteryExempt(this)) requestBatteryExemption()
    }

    @Suppress("BatteryLife") // The whole purpose of this app is to keep working in the background, and it is not on Google Play.
    fun requestBatteryExemption() {
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (e: ActivityNotFoundException) {
            openAppSettings()
        }
    }

    fun openAppSettings() {
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
    }

    fun showFileChooser(params: WebChromeClient.FileChooserParams) {
        val intent = params.createIntent().apply {
            if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        try {
            startActivityForResult(intent, REQUEST_FILES)
        } catch (e: ActivityNotFoundException) {
            EngineHost.filePathCallback?.onReceiveValue(null)
            EngineHost.filePathCallback = null
            Toast.makeText(this, "No app on this phone can pick files.", Toast.LENGTH_LONG).show()
        }
    }

    @Deprecated("Part of the plain Activity API, which is all this app uses.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_FILES) return
        val callback = EngineHost.filePathCallback ?: return
        EngineHost.filePathCallback = null
        val clip = data?.clipData
        val picked = when {
            resultCode != RESULT_OK -> null
            clip != null -> Array(clip.itemCount) { clip.getItemAt(it).uri }
            data?.data != null -> arrayOf(data.data!!)
            else -> null
        }
        callback.onReceiveValue(picked)
    }

    private companion object {
        const val REQUEST_GALLERY = 1
        const val REQUEST_FILES = 2
    }
}
