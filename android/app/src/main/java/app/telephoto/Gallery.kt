package app.telephoto

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.FileNotFoundException

/** Reads the phone's gallery. Nothing in this app ever writes to it or deletes from it. */
object Gallery {
    private val IMAGES = MediaStore.Images.Media.EXTERNAL_CONTENT_URI

    private fun granted(context: Context, permission: String) =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    /** Everything that has to be asked for, in one go. */
    fun neededPermissions(): Array<String> = buildList {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            add(Manifest.permission.READ_MEDIA_IMAGES)
            add(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.READ_MEDIA_IMAGES)
        } else {
            add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        add(Manifest.permission.ACCESS_MEDIA_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
    }.toTypedArray()

    /**
     * "all", "partial" for only the photos someone picked, or "none".
     * Reading without the location permission counts as none, because the files would not be the originals.
     */
    fun access(context: Context): String {
        if (!granted(context, Manifest.permission.ACCESS_MEDIA_LOCATION)) return "none"
        return when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && granted(context, Manifest.permission.READ_MEDIA_IMAGES) -> "all"
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

    /** One page of rows, as [id, name, size, modified seconds, taken milliseconds or null]. */
    fun list(context: Context, afterId: Long, limit: Int): String {
        val rows = JSONArray()
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.SIZE,
            MediaStore.Images.Media.DATE_MODIFIED,
            MediaStore.Images.Media.DATE_TAKEN,
        )
        val query = android.os.Bundle().apply {
            putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, "${MediaStore.Images.Media._ID} > ?")
            putStringArray(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, arrayOf(afterId.toString()))
            putString(android.content.ContentResolver.QUERY_ARG_SQL_SORT_ORDER, "${MediaStore.Images.Media._ID} ASC")
            putInt(android.content.ContentResolver.QUERY_ARG_LIMIT, limit)
        }
        context.contentResolver.query(IMAGES, projection, query, null)?.use { cursor ->
            while (cursor.moveToNext()) {
                val id = cursor.getLong(0)
                val taken = if (cursor.isNull(4)) 0L else cursor.getLong(4)
                rows.put(
                    JSONArray()
                        .put(id)
                        .put(cursor.getString(1) ?: "photo-$id")
                        .put(cursor.getLong(2))
                        .put(cursor.getLong(3))
                        .put(if (taken > 0) taken else JSONObject.NULL),
                )
            }
        }
        return rows.toString()
    }

    /**
     * Opens a photo's original file. setRequireOriginal is what stops Android removing the location,
     * and it throws rather than falling back when that is not allowed, which is the behaviour wanted.
     */
    @Throws(SecurityException::class, UnsupportedOperationException::class, FileNotFoundException::class)
    fun openOriginal(context: Context, id: Long): ParcelFileDescriptor {
        val uri = MediaStore.setRequireOriginal(ContentUris.withAppendedId(IMAGES, id))
        return context.contentResolver.openFileDescriptor(uri, "r") ?: throw FileNotFoundException("Photo $id")
    }
}
