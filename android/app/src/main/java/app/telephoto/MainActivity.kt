package app.telephoto

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.WebChromeClient
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import android.widget.FrameLayout
import android.widget.Toast

/** The screen. It only shows the page, which belongs to EngineHost and outlives this. */
class MainActivity : Activity() {
    private lateinit var root: FrameLayout
    private var backCallback: Any? = null
    private var fullscreen: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

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
        hideFullscreen(tellPage = true)
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
        if (fullscreen != null) {
            hideFullscreen(tellPage = true)
            return
        }
        EngineHost.back { moveTaskToBack(true) }
    }

    /** A video filling the screen, over everything, with the system bars out of the way until swiped in. */
    fun showFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
        hideFullscreen(tellPage = true)
        fullscreen = view
        fullscreenCallback = callback
        view.setBackgroundColor(Color.BLACK)
        (window.decorView as ViewGroup).addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        systemBars(show = false)
    }

    /** @param tellPage false when the page has left fullscreen itself and is only saying so. */
    fun hideFullscreen(tellPage: Boolean) {
        val view = fullscreen ?: return
        val callback = fullscreenCallback
        // Cleared first, as telling the page makes WebView call back into this.
        fullscreen = null
        fullscreenCallback = null
        (window.decorView as ViewGroup).removeView(view)
        systemBars(show = true)
        if (tellPage) callback?.onCustomViewHidden()
    }

    private fun systemBars(show: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val controller = window.insetsController ?: return
            if (show) {
                controller.show(WindowInsets.Type.systemBars())
            } else {
                controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                controller.hide(WindowInsets.Type.systemBars())
            }
        } else {
            @Suppress("DEPRECATION") // Android 10 has no other way.
            window.decorView.systemUiVisibility = if (show) View.SYSTEM_UI_FLAG_VISIBLE else
                View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        }
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
        // createIntent() keeps only the first accepted type, which would leave out videos. Extensions such as .heic are covered by image/* already.
        val types = params.acceptTypes.flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { '/' in it }.distinct()
        val intent = params.createIntent().apply {
            if (types.size > 1) {
                type = "*/*"
                putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
            }
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
