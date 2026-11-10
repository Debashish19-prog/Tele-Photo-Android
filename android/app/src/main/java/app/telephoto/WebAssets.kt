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
import java.io.InputStream

/**
 * Serves the website from inside the APK, and gallery files by their id.
 *
 * Nothing listens on a port. These answers only ever reach this app's own WebView, so no other app
 * on the phone can ask for a photo or video this way.
 */
object WebAssets {
    const val HOST = "appassets.androidplatform.net"
    const val ORIGIN = "https://$HOST"
    private const val TAG = "TelePhoto"
    private const val GALLERY_PREFIX = "/_gallery/"

    /** The same rules as vercel.json, so the page cannot send anything anywhere but Telegram. */
    private const val CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; connect-src 'self' wss://*.web.telegram.org; object-src 'none'; " +
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
            return if (request.method == "GET") galleryFile(context, url) else failure(405, "Method Not Allowed")
        }
        return asset(context, path)
    }

    /** Asked for more than this, a poster is made at this size, as nothing shows one any larger. */
    private const val LARGEST_POSTER = 2560

    /**
     * A gallery file, read as the original. Three forms:
     * - `/_gallery/<id>`: the whole file, as for a photo.
     * - `/_gallery/<id>?start=&end=&version=`: only those bytes, so a large video never has to be
     *   copied anywhere to be backed up. Refused with 409 if the file has changed since `version`.
     *   `start=0&end=0` reads nothing, and only tells the size and version.
     * - `/_gallery/<id>?poster=<edge>`: Android's own still from a video, as a JPEG.
     */
    private fun galleryFile(context: Context, url: Uri): WebResourceResponse {
        val path = url.path ?: return failure(400, "Bad Request")
        val id = path.removePrefix(GALLERY_PREFIX).toLongOrNull()?.takeIf { it > 0 } ?: return failure(400, "Bad Request")
        url.getQueryParameter("poster")?.let { return poster(context, id, it.toIntOrNull()) }
        val original: Gallery.Original = try {
            Gallery.openOriginal(context, id)
        } catch (e: FileNotFoundException) {
            return failure(404, "Not Found")
        } catch (e: SecurityException) {
            // Never fall back to the version with the location removed. It would not be the original.
            Log.w(TAG, "No access to the original of gallery file $id", e)
            return failure(403, "Forbidden")
        } catch (e: UnsupportedOperationException) {
            Log.w(TAG, "No access to the original of gallery file $id", e)
            return failure(403, "Forbidden")
        } catch (e: IllegalArgumentException) {
            return failure(404, "Not Found")
        }
        val input = ParcelFileDescriptor.AutoCloseInputStream(original.file)
        val expected = url.getQueryParameter("version")
        if (expected != null && expected != original.version) {
            input.close()
            return failure(409, "Conflict")
        }
        val headers = SECURITY_HEADERS + mapOf(
            "X-Tele-Photo-Size" to original.size.toString(),
            "X-Tele-Photo-Version" to original.version,
            "Cache-Control" to "no-store",
        )
        val start = url.getQueryParameter("start")
        val end = url.getQueryParameter("end")
        if (start == null && end == null) {
            return WebResourceResponse("application/octet-stream", null, 200, "OK", headers + ("Content-Length" to original.size.toString()), input)
        }
        val from = start?.toLongOrNull()
        val to = end?.toLongOrNull()
        if (from == null || to == null || from < 0 || to < from || to > original.size) {
            input.close()
            return failure(416, "Range Not Satisfiable")
        }
        return try {
            input.channel.position(from)
            WebResourceResponse("application/octet-stream", null, 200, "OK", headers + ("Content-Length" to (to - from).toString()), Limited(input, to - from))
        } catch (e: IOException) {
            input.close()
            Log.w(TAG, "Could not read gallery file $id", e)
            failure(500, "Internal Server Error")
        }
    }

    private fun poster(context: Context, id: Long, edge: Int?): WebResourceResponse {
        if (edge == null || edge <= 0) return failure(400, "Bad Request")
        val poster = try {
            Gallery.poster(context, id, minOf(edge, LARGEST_POSTER))
        } catch (e: FileNotFoundException) {
            return failure(404, "Not Found")
        } catch (e: IOException) {
            // Android could not make one, as for a format it cannot play. The video is still backed up.
            return failure(404, "Not Found")
        } catch (e: SecurityException) {
            return failure(403, "Forbidden")
        }
        val headers = SECURITY_HEADERS + mapOf(
            "X-Tele-Photo-Width" to poster.width.toString(),
            "X-Tele-Photo-Height" to poster.height.toString(),
            "Content-Length" to poster.jpeg.size.toString(),
            "Cache-Control" to "no-store",
        )
        return WebResourceResponse("image/jpeg", null, 200, "OK", headers, ByteArrayInputStream(poster.jpeg))
    }

    /** Stops after `left` bytes, so a range read ends where it was asked to. */
    private class Limited(private val input: InputStream, private var left: Long) : InputStream() {
        override fun read(): Int {
            if (left <= 0) return -1
            val byte = input.read()
            if (byte >= 0) left--
            return byte
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (left <= 0) return -1
            val count = input.read(buffer, offset, minOf(length.toLong(), left).toInt())
            if (count > 0) left -= count
            return count
        }

        override fun available(): Int = minOf(input.available().toLong(), left).toInt()

        override fun close() = input.close()
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
