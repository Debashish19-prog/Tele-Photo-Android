package app.telephoto

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.OutputStream

/**
 * What the page can ask of the phone. These run on a background thread of WebView's, and anything
 * that touches the rest of the app hops to the main thread through EngineHost.
 *
 * Only this app's own page can reach this: EngineHost blocks navigating anywhere else, and the
 * page's content security policy blocks loading any outside script.
 */
class Bridge(private val context: Context) {
    private val prefs = Prefs(context)

    private class Save(val uri: Uri, val output: OutputStream)
    private val saves = HashMap<Int, Save>()
    private var nextSave = 1

    @JavascriptInterface fun ready() = EngineHost.post { EngineHost.pageReady() }
    @JavascriptInterface fun access(): String = Gallery.access(context)
    @JavascriptInterface fun network(): String = Gallery.network(context)
    @JavascriptInterface fun listGallery(afterId: Double, limit: Int): String = Gallery.list(context, afterId.toLong(), limit)

    @JavascriptInterface
    fun settings(): String = JSONObject()
        .put("enabled", prefs.enabled)
        .put("mobileData", prefs.mobileData)
        .put("batteryExempt", SyncScheduler.isBatteryExempt(context))
        .toString()

    @JavascriptInterface
    fun setEnabled(enabled: Boolean) {
        prefs.enabled = enabled
        SyncScheduler.arm(context)
    }

    @JavascriptInterface
    fun setMobileData(allowed: Boolean) {
        prefs.mobileData = allowed
        SyncScheduler.arm(context)
    }

    @JavascriptInterface fun requestAccess() = EngineHost.post { EngineHost.activity?.requestGalleryAccess() }
    @JavascriptInterface fun requestBatteryExemption() = EngineHost.post { EngineHost.activity?.requestBatteryExemption() }
    @JavascriptInterface fun openAppSettings() = EngineHost.post { EngineHost.activity?.openAppSettings() }
    @JavascriptInterface fun report(status: String) = EngineHost.post { EngineHost.onReport(JSONObject(status)) }
    @JavascriptInterface fun finished(outcome: String) = EngineHost.post { EngineHost.onFinished(JSONObject(outcome)) }

    /** Downloads go in Downloads, which needs no permission from Android 10 on. Returns -1 on failure. */
    @JavascriptInterface
    fun beginSave(name: String, mime: String): Int = synchronized(saves) {
        try {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return -1
            val output = resolver.openOutputStream(uri) ?: run {
                resolver.delete(uri, null, null)
                return -1
            }
            val handle = nextSave++
            saves[handle] = Save(uri, output)
            handle
        } catch (e: Exception) {
            Log.w("TelePhoto", "Could not start saving a file", e)
            -1
        }
    }

    @JavascriptInterface
    fun writeSave(handle: Int, base64: String): Boolean = synchronized(saves) {
        val save = saves[handle] ?: return false
        try {
            save.output.write(Base64.decode(base64, Base64.DEFAULT))
            true
        } catch (e: Exception) {
            Log.w("TelePhoto", "Could not save a file", e)
            false
        }
    }

    @JavascriptInterface
    fun finishSave(handle: Int, ok: Boolean): Boolean = synchronized(saves) {
        val save = saves.remove(handle) ?: return false
        val resolver = context.contentResolver
        try {
            save.output.close()
            if (ok) {
                resolver.update(save.uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            } else {
                resolver.delete(save.uri, null, null)
            }
            ok
        } catch (e: Exception) {
            Log.w("TelePhoto", "Could not finish saving a file", e)
            resolver.delete(save.uri, null, null)
            false
        }
    }
}
