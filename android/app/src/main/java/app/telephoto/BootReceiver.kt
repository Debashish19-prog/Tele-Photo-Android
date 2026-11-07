package app.telephoto

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Android forgets the "gallery changed" job on a restart or an update, so it is set up again here. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        SyncScheduler.arm(context)
    }
}
