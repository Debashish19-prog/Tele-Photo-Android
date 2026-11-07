package app.telephoto

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject

object SyncNotifications {
    const val ID_PROGRESS = 1
    private const val ID_ATTENTION = 2
    private const val CHANNEL_PROGRESS = "backup_progress"
    private const val CHANNEL_ATTENTION = "backup_attention"

    private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)

    private fun ensureChannels(context: Context) {
        manager(context).createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_PROGRESS, "Backup progress", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
                NotificationChannel(CHANNEL_ATTENTION, "Backup needs you", NotificationManager.IMPORTANCE_DEFAULT),
            ),
        )
    }

    private fun openApp(context: Context) = PendingIntent.getActivity(
        context, 0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    fun progress(context: Context, status: JSONObject?): Notification {
        ensureChannels(context)
        val done = status?.optInt("done") ?: 0
        val remaining = status?.optInt("remaining") ?: 0
        val failing = status?.optInt("failing") ?: 0
        val total = done + remaining + failing
        val builder = Notification.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Backing up your photos")
            .setContentIntent(openApp(context))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
        // A quick look for new photos is over before this would be worth showing.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_DEFERRED)
        if (total > 0) {
            builder.setContentText("$done of $total").setProgress(total, done, false)
        } else {
            builder.setContentText("Looking for new photos").setProgress(0, 0, true)
        }
        return builder.build()
    }

    fun showProgress(context: Context, status: JSONObject) {
        manager(context).notify(ID_PROGRESS, progress(context, status))
    }

    /** Only speaks up when backups have stopped and only the person can start them again. */
    fun pass(context: Context, phase: String) {
        val text = when (phase) {
            "needs-sign-in" -> "Telegram ended this session. Open the app and sign in again to keep backing up."
            "no-access" -> "Tele-Photo can no longer read your photos. Open the app to allow it again."
            else -> {
                manager(context).cancel(ID_ATTENTION)
                return
            }
        }
        ensureChannels(context)
        manager(context).notify(
            ID_ATTENTION,
            Notification.Builder(context, CHANNEL_ATTENTION)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Auto backup has stopped")
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(openApp(context))
                .setAutoCancel(true)
                .build(),
        )
    }

    fun dismissAttention(context: Context) {
        manager(context).cancel(ID_ATTENTION)
    }
}
