package app.telephoto

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.Uri
import android.net.NetworkCapabilities
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.provider.MediaStore.Files.FileColumns
import android.system.ErrnoException
import android.system.Os
import android.util.Size
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.IOException

/** Reads the phone's gallery. Nothing in this app ever writes to it or deletes from it. */
object Gallery {
    /**
     * Photos and videos are both rows of this one table, so an id never belongs to more than one
     * file, and paging through both in id order needs only one query.
     */
    private val FILES = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL)
    private val IMAGES = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    private val VIDEOS = MediaStore.Video.Media.EXTERNAL_CONTENT_URI
    private val PHOTOS_AND_VIDEOS = "${FileColumns.MEDIA_TYPE} IN (${FileColumns.MEDIA_TYPE_IMAGE}, ${FileColumns.MEDIA_TYPE_VIDEO})"

    private fun granted(context: Context, permission: String) =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    /** Everything that has to be asked for, in one go. */
    fun neededPermissions(): Array<String> = buildList {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Asked together, Android shows these as one question about photos and videos.
            add(Manifest.permission.READ_MEDIA_IMAGES)
            add(Manifest.permission.READ_MEDIA_VIDEO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) add(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
        } else {
            add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        add(Manifest.permission.ACCESS_MEDIA_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
    }.toTypedArray()

    /**
     * "all", "partial" for only the photos and videos someone picked, or "none".
     * Reading without the location permission counts as none, because the files would not be the originals.
     */
    fun access(context: Context): String {
        if (!granted(context, Manifest.permission.ACCESS_MEDIA_LOCATION)) return "none"
        return when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                granted(context, Manifest.permission.READ_MEDIA_IMAGES) && granted(context, Manifest.permission.READ_MEDIA_VIDEO) -> "all"
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU && granted(context, Manifest.permission.READ_EXTERNAL_STORAGE) -> "all"
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && granted(context, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> "partial"
            else -> "none"
        }
    }

    /** "unmetered", "metered" or "none". Android decides what counts as metered, including a phone's hotspot. */
    fun network(context: Context): String {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return "none"
        // Not "validated", as that is Google's own reachability check, which can fail where Telegram works.
        if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return "none"
        return if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) "unmetered" else "metered"
    }

    /** One page of photos and videos, as [id, name, size, modified seconds, taken milliseconds or null, "photo" or "video"]. */
    fun list(context: Context, afterId: Long, limit: Int): String {
        val rows = JSONArray()
        val projection = arrayOf(
            FileColumns._ID,
            FileColumns.DISPLAY_NAME,
            FileColumns.SIZE,
            FileColumns.DATE_MODIFIED,
            FileColumns.DATE_TAKEN,
            FileColumns.MEDIA_TYPE,
        )
        val query = android.os.Bundle().apply {
            putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, "$PHOTOS_AND_VIDEOS AND ${FileColumns._ID} > ?")
            putStringArray(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, arrayOf(afterId.toString()))
            putString(android.content.ContentResolver.QUERY_ARG_SQL_SORT_ORDER, "${FileColumns._ID} ASC")
            putInt(android.content.ContentResolver.QUERY_ARG_LIMIT, limit)
        }
        context.contentResolver.query(FILES, projection, query, null)?.use { cursor ->
            while (cursor.moveToNext()) {
                val id = cursor.getLong(0)
                val taken = if (cursor.isNull(4)) 0L else cursor.getLong(4)
                val kind = if (cursor.getInt(5) == FileColumns.MEDIA_TYPE_VIDEO) "video" else "photo"
                rows.put(
                    JSONArray()
                        .put(id)
                        .put(cursor.getString(1) ?: "$kind-$id")
                        .put(cursor.getLong(2))
                        .put(cursor.getLong(3))
                        .put(if (taken > 0) taken else JSONObject.NULL)
                        .put(kind),
                )
            }
        }
        return rows.toString()
    }

    private class Info(val type: Int, val width: Int, val height: Int)

    @Throws(FileNotFoundException::class)
    private fun describe(context: Context, id: Long): Info {
        val query = android.os.Bundle().apply {
            putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, "$PHOTOS_AND_VIDEOS AND ${FileColumns._ID} = ?")
            putStringArray(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, arrayOf(id.toString()))
        }
        val projection = arrayOf(FileColumns.MEDIA_TYPE, FileColumns.WIDTH, FileColumns.HEIGHT)
        return context.contentResolver.query(FILES, projection, query, null)?.use { cursor ->
            if (cursor.moveToFirst()) Info(cursor.getInt(0), cursor.getInt(1), cursor.getInt(2)) else null
        } ?: throw FileNotFoundException("Gallery file $id")
    }

    /** The collection a file belongs to, as only those, not the table of all files, can give out an original. */
    private fun collectionOf(info: Info) = if (info.type == FileColumns.MEDIA_TYPE_VIDEO) VIDEOS else IMAGES

    /**
     * An open original. `version` changes whenever the file does, so that a file read a piece at a
     * time can tell if it was edited partway through, rather than end up as two versions in one.
     */
    class Original(val file: ParcelFileDescriptor, val size: Long, val version: String)

    /**
     * Opens a photo's or video's original file. setRequireOriginal is what stops Android removing the
     * location, from videos as well as photos, and it throws rather than falling back when that is
     * not allowed, which is the behaviour wanted.
     */
    @Throws(SecurityException::class, UnsupportedOperationException::class, FileNotFoundException::class)
    fun openOriginal(context: Context, id: Long): Original {
        val uri = MediaStore.setRequireOriginal(ContentUris.withAppendedId(collectionOf(describe(context, id)), id))
        val file = context.contentResolver.openFileDescriptor(uri, "r") ?: throw FileNotFoundException("Gallery file $id")
        // From the file itself, as Android's index of the gallery only catches up with a change later.
        val stat = try {
            Os.fstat(file.fileDescriptor)
        } catch (e: ErrnoException) {
            file.close()
            throw FileNotFoundException("Gallery file $id: ${e.message}")
        }
        return Original(file, stat.st_size, "${stat.st_size}-${stat.st_mtim.tv_sec}.${stat.st_mtim.tv_nsec}")
    }

    /** A still from a video, and the video's own size, which the still may be smaller than. */
    class Poster(val jpeg: ByteArray, val width: Int, val height: Int)

    /** Made by Android, so a video never has to be played in a page nobody can see to get one. */
    @Throws(FileNotFoundException::class, IOException::class)
    fun poster(context: Context, id: Long, edge: Int): Poster {
        val info = describe(context, id)
        if (info.type != FileColumns.MEDIA_TYPE_VIDEO) throw FileNotFoundException("Gallery file $id is not a video")
        val bitmap = context.contentResolver.loadThumbnail(ContentUris.withAppendedId(VIDEOS, id), Size(edge, edge), null)
        val out = ByteArrayOutputStream()
        try {
            bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)
        } finally {
            bitmap.recycle()
        }
        return Poster(out.toByteArray(), info.width, info.height)
    }
}
