package app.telephoto

import android.content.Context

/** The settings Android needs before any web page has loaded, such as whether to wake up at all. */
class Prefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("auto_backup", Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = prefs.getBoolean("enabled", false)
        set(value) = prefs.edit().putBoolean("enabled", value).apply()

    /** Off unless the person turns it on, as originals can use a lot of someone's data plan. */
    var mobileData: Boolean
        get() = prefs.getBoolean("mobile_data", false)
        set(value) = prefs.edit().putBoolean("mobile_data", value).apply()

    /** Set when Android refuses a foreground service, so that jobs stop trying for a while. */
    var foregroundBlockedUntil: Long
        get() = prefs.getLong("foreground_blocked_until", 0)
        set(value) = prefs.edit().putLong("foreground_blocked_until", value).apply()
}
