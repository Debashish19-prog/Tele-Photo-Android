package app.telephoto

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.MutableContextWrapper
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.ContextThemeWrapper
import android.view.View
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/** Something that needs a backup pass to run, and has to know when it ends. */
fun interface PassHolder {
    fun passEnded(wantsMore: Boolean)
}

/**
 * Owns the one WebView, which holds the whole app: the library, the Telegram connection and the backup.
 *
 * It belongs to the process rather than to a screen. The screen borrows it while open, and a job or
 * service can run it with no screen at all. Keeping to one means there is only ever one copy of the
 * library in memory, which is a rule the rest of the app depends on, and opening the app during a
 * backup simply shows that same backup still running.
 */
@SuppressLint("StaticFieldLeak", "SetJavaScriptEnabled")
object EngineHost {
    private const val TAG = "TelePhoto"
    /** A page this quiet has hung. It reports at least every 30 seconds, even during one long upload. */
    private const val STALL_MS = 4 * 60_000L
    private const val WATCHDOG_MS = 60_000L
    /** Long enough that coming straight back to the app does not reload it. */
    private const val RELEASE_DELAY_MS = 15_000L
    private const val MAX_CRASHES = 3
    private const val CRASH_WINDOW_MS = 10 * 60_000L
    /** Used while the screen is closed. A page with no size can do odd things with its layout. */
    private const val OFFSCREEN_WIDTH = 1080
    private const val OFFSCREEN_HEIGHT = 2400

    private val main = Handler(Looper.getMainLooper())
    private lateinit var appContext: Context
    private var webView: WebView? = null
    private var wrapper: MutableContextWrapper? = null
    private var ready = false
    private var passActive = false
    private var serviceAsked = false
    private var lastHeard = 0L
    private val holders = LinkedHashSet<PassHolder>()
    private var crashTimes = ArrayDeque<Long>()

    var activity: MainActivity? = null
        private set
    var filePathCallback: ValueCallback<Array<Uri>>? = null

    fun post(work: () -> Unit) {
        main.post(work)
    }

    private fun send(event: String, onResult: ((String?) -> Unit)? = null) {
        webView?.evaluateJavascript("window.telePhotoNative ? window.telePhotoNative('$event') : false") { onResult?.invoke(it) }
    }

    private fun ensure(context: Context): WebView {
        appContext = context.applicationContext
        webView?.let { return it }

        val debuggable = appContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        WebView.setWebContentsDebuggingEnabled(debuggable)

        val base = MutableContextWrapper(themed())
        val view = WebView(base)
        wrapper = base
        ready = false
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            setSupportMultipleWindows(false)
        }
        view.setBackgroundColor(0)
        // A backup with the screen off must not be the first thing Android takes away under memory pressure.
        view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        view.addJavascriptInterface(Bridge(appContext), "TelePhotoAndroid")
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        sizeOffscreen(view)
        view.loadUrl("${WebAssets.ORIGIN}/")
        webView = view
        lastHeard = SystemClock.elapsedRealtime()
        return view
    }

    /** The theme is how the page learns light or dark, so it has to be there with no screen open too. */
    private fun themed(): Context = ContextThemeWrapper(appContext, R.style.AppTheme)

    private fun sizeOffscreen(view: WebView) {
        view.measure(
            View.MeasureSpec.makeMeasureSpec(OFFSCREEN_WIDTH, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(OFFSCREEN_HEIGHT, View.MeasureSpec.EXACTLY),
        )
        view.layout(0, 0, OFFSCREEN_WIDTH, OFFSCREEN_HEIGHT)
    }

    // ---- the screen ----------------------------------------------------------------------------

    fun attach(screen: MainActivity): WebView {
        main.removeCallbacks(releaseIfUnused)
        val view = ensure(screen)
        (view.parent as? android.view.ViewGroup)?.removeView(view)
        wrapper?.baseContext = screen
        activity = screen
        return view
    }

    fun detach(screen: MainActivity) {
        if (activity !== screen) return
        activity = null
        wrapper?.baseContext = themed()
        webView?.let { view ->
            (view.parent as? android.view.ViewGroup)?.removeView(view)
            sizeOffscreen(view)
        }
        scheduleRelease()
    }

    /** Back closes whatever is open on top first. Returns through onUnhandled if nothing was. */
    fun back(onUnhandled: () -> Unit) {
        send("back") { handled ->
            if (handled == "true") return@send
            val view = webView
            if (view != null && view.canGoBack()) view.goBack() else onUnhandled()
        }
    }

    fun accessChanged() = send("access-changed")

    // ---- backup passes --------------------------------------------------------------------------

    /** Keeps the page running until the current pass ends, starting one if needed. */
    fun begin(context: Context, holder: PassHolder) {
        main.removeCallbacks(releaseIfUnused)
        holders += holder
        ensure(context)
        lastHeard = SystemClock.elapsedRealtime()
        startWatchdog()
        // Otherwise the page starts a pass by itself as soon as it has loaded.
        if (ready && !passActive) send("run")
    }

    /** Asks to run a pass with nothing depending on it, such as coming back to the app. */
    fun requestRun() {
        if (ready) send("run")
    }

    /** The holder has been told to stop by Android. The page stops too, unless someone else needs it. */
    fun end(holder: PassHolder) {
        holders -= holder
        if (holders.isEmpty() && activity == null) {
            send("pause")
            scheduleRelease()
        }
    }

    val isPassActive get() = passActive

    fun pageReady() {
        ready = true
        lastHeard = SystemClock.elapsedRealtime()
    }

    fun onReport(status: JSONObject) {
        lastHeard = SystemClock.elapsedRealtime()
        val phase = status.optString("phase")
        passActive = phase == "checking" || phase == "backing-up"
        // The screen being open is the moment Android allows this. It carries on after the screen closes.
        if (phase == "backing-up" && !serviceAsked && !SyncService.isRunning) {
            serviceAsked = true
            SyncService.tryStart(appContext)
        }
        SyncService.update(status)
    }

    fun onFinished(outcome: JSONObject) {
        lastHeard = SystemClock.elapsedRealtime()
        passActive = false
        serviceAsked = false
        val phase = outcome.optString("phase")
        val remaining = outcome.optInt("remaining")
        val resumeAt = if (outcome.isNull("resumeAt")) 0L else outcome.optLong("resumeAt")
        Log.i(TAG, "Backup pass ended: $phase, $remaining left")

        SyncNotifications.pass(appContext, phase)
        val wantsMore = remaining > 0 || resumeAt > 0
        if (Prefs(appContext).enabled && wantsMore && phase != "no-access" && phase != "needs-sign-in") {
            SyncScheduler.scheduleResume(appContext, resumeAt)
        }
        val ending = holders.toList()
        holders.clear()
        for (holder in ending) holder.passEnded(wantsMore)
        scheduleRelease()
    }

    private fun scheduleRelease() {
        main.removeCallbacks(releaseIfUnused)
        main.postDelayed(releaseIfUnused, RELEASE_DELAY_MS)
    }

    /** With no screen and no backup, the page goes away so the phone gets its memory back. */
    private val releaseIfUnused = Runnable {
        if (activity == null && holders.isEmpty()) destroy()
    }

    private fun destroy() {
        webView?.let { view ->
            (view.parent as? android.view.ViewGroup)?.removeView(view)
            view.stopLoading()
            view.destroy()
        }
        webView = null
        wrapper = null
        ready = false
        passActive = false
        serviceAsked = false
    }

    private fun startWatchdog() {
        main.removeCallbacks(watchdog)
        main.postDelayed(watchdog, WATCHDOG_MS)
    }

    private val watchdog: Runnable = Runnable {
        if (holders.isEmpty()) return@Runnable
        if (SystemClock.elapsedRealtime() - lastHeard > STALL_MS) {
            Log.w(TAG, "The page has stopped responding, so this backup pass is ending")
            giveUp()
        } else {
            startWatchdog()
        }
    }

    /** Ends the pass from this side, and leaves a job to try again. */
    private fun giveUp() {
        val screen = activity
        destroy()
        val ending = holders.toList()
        holders.clear()
        if (Prefs(appContext).enabled) SyncScheduler.scheduleResume(appContext, 0)
        for (holder in ending) holder.passEnded(true)
        screen?.reattach()
    }

    /**
     * The page's process died, usually from decoding a huge photo. Android ends the whole app if this
     * is not handled. It starts the page again, and the backup carries on. The ledger remembers which
     * photo was being prepared, so that one gets stored without a thumbnail the next time around.
     */
    private fun onRendererGone() {
        val now = SystemClock.elapsedRealtime()
        crashTimes.addLast(now)
        while (crashTimes.isNotEmpty() && now - crashTimes.first() > CRASH_WINDOW_MS) crashTimes.removeFirst()
        val screen = activity
        destroy()
        if (crashTimes.size > MAX_CRASHES && holders.isNotEmpty()) {
            Log.w(TAG, "The page keeps crashing, so this backup pass is ending")
            giveUp()
            return
        }
        if (screen != null) screen.reattach()
        else if (holders.isNotEmpty()) ensure(appContext)
    }

    private class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            WebAssets.respond(appContext, request)

        /** The page's own links stay here. Anything else opens in the phone's browser, away from the bridge. */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (WebAssets.isOurs(request.url)) return false
            try {
                val intent = Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (request.url.scheme == "https") appContext.startActivity(intent)
            } catch (e: Exception) {
                Log.w(TAG, "Could not open a link", e)
            }
            return true
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.w(TAG, "The page's process ended. Crashed: ${detail.didCrash()}")
            if (view === webView) post { onRendererGone() }
            return true
        }
    }

    private class Chrome : WebChromeClient() {
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            val screen = activity
            if (screen == null) {
                callback.onReceiveValue(null)
                return true
            }
            filePathCallback?.onReceiveValue(null)
            filePathCallback = callback
            screen.showFileChooser(params)
            return true
        }
    }
}
