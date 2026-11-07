package app.telephoto

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.FileNotFoundException
import java.io.IOException

/**
 * Serves the website from inside the APK, and gallery files by their id.
 *
 * Nothing listens on a port. These answers only ever reach this app's own WebView, so no other app
 * on the phone can ask for a photo this way.
 */
object WebAssets {
    const val HOST = "appassets.androidplatform.net"
    const val ORIGIN = "https://$HOST"
    private const val TAG = "TelePhoto"
    private const val GALLERY_PREFIX = "/_gallery/"

    /** The same rules as vercel.json, so the page cannot send anything anywhere but Telegram. */
    private const val CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' blob: data:; font-src 'self'; connect-src 'self' wss://*.web.telegram.org; object-src 'none'; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

    private val SECURITY_HEADERS = mapOf(
        "Content-Security-Policy" to CSP,
        "X-Content-Type-Options" to "nosniff",
        "Referrer-Policy" to "no-referrer",
    )

    private val MIME_TYPES = mapOf(
        "html" to "text/html", "js" to "text/javascript", "mjs" to "text/javascript", "css" to "text/css",
        "svg" to "image/svg+xml", "webp" to "image/webp", "png" to "image/png", "jpg" to "image/jpeg",
        "woff2" to "font/woff2", "woff" to "font/woff", "wasm" to "application/wasm", "json" to "application/json",
    )

    fun isOurs(url: Uri) = url.scheme == "https" && url.host == HOST

    fun respond(context: Context, request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (!isOurs(url)) return null
        val path = url.path ?: "/"
        if (path.startsWith(GALLERY_PREFIX)) {
            return if (request.method == "GET") galleryFile(context, path) else failure(405, "Method Not Allowed")
        }
        return asset(context, path)
    }

    private fun galleryFile(context: Context, path: String): WebResourceResponse {
        val id = path.removePrefix(GALLERY_PREFIX).toLongOrNull()?.takeIf { it > 0 } ?: return failure(400, "Bad Request")
        val file: ParcelFileDescriptor = try {
            Gallery.openOriginal(context, id)
        } catch (e: FileNotFoundException) {
            return failure(404, "Not Found")
        } catch (e: SecurityException) {
            // Never fall back to the version with the location removed. It would not be the original.
            Log.w(TAG, "No access to the original of photo $id", e)
            return failure(403, "Forbidden")
        } catch (e: UnsupportedOperationException) {
            Log.w(TAG, "No access to the original of photo $id", e)
            return failure(403, "Forbidden")
        } catch (e: IllegalArgumentException) {
            return failure(404, "Not Found")
        }
        val headers = SECURITY_HEADERS + mapOf(
            "X-Tele-Photo-Size" to file.statSize.toString(),
            "Content-Length" to file.statSize.toString(),
            "Cache-Control" to "no-store",
        )
        return WebResourceResponse("application/octet-stream", null, 200, "OK", headers, ParcelFileDescriptor.AutoCloseInputStream(file))
    }

    private fun asset(context: Context, path: String): WebResourceResponse {
        val relative = path.trimStart('/').ifEmpty { "index.html" }
        // A page in the app has no file of its own. Only real files have an extension.
        val isPage = !relative.substringAfterLast('/').contains('.')
        val name = if (isPage) "index.html" else relative
        if (name.split('/').any { it == ".." }) return failure(404, "Not Found")
        return try {
            val stream = context.assets.open("www/$name")
            val extension = name.substringAfterLast('.', "").lowercase()
            val cache = if (name.startsWith("assets/")) "public, max-age=31536000, immutable" else "no-cache"
            val mime = MIME_TYPES[extension] ?: "application/octet-stream"
            val encoding = if (mime.startsWith("text/") || mime.endsWith("json")) "utf-8" else null
            WebResourceResponse(mime, encoding, 200, "OK", SECURITY_HEADERS + ("Cache-Control" to cache), stream)
        } catch (e: IOException) {
            failure(404, "Not Found")
        }
    }

    private fun failure(status: Int, reason: String) =
        WebResourceResponse("text/plain", "utf-8", status, reason, SECURITY_HEADERS, ByteArrayInputStream(ByteArray(0)))
}
