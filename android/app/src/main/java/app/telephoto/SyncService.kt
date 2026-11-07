package app.telephoto

import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Keeps a backup running with the app closed and the screen off. It shows a notification while it
 * is working, as Android requires, and stops as soon as there is nothing left to do.
 */
class SyncService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var holder: PassHolder? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            startForeground(SyncNotifications.ID_PROGRESS, SyncNotifications.progress(this, null), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } catch (e: RuntimeException) {
            // Android 15 and up allow only so many hours of this a day. A job carries on instead.
            Log.w(TAG, "Android refused the foreground service", e)
            blockForAWhile(this)
            if (Prefs(this).enabled) SyncScheduler.scheduleResume(this, 0)
            stopSelf()
            return START_NOT_STICKY
        }
        running = this
        acquireLocks()
        if (holder == null) {
            val mine = PassHolder {
                holder = null
                stopSelf()
            }
            holder = mine
            EngineHost.begin(this, mine)
        } else {
            EngineHost.requestRun()
        }
        return START_NOT_STICKY
    }

    @SuppressLint("WakelockTimeout")
    private fun acquireLocks() {
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "telephoto:backup")
                .apply { acquire(TimeUnit.HOURS.toMillis(7)) }
        }
        if (wifiLock == null) {
            @Suppress("DEPRECATION")
            wifiLock = getSystemService(WifiManager::class.java)
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "telephoto:backup")
                .apply { acquire() }
        }
    }

    /** Called by Android when today's allowance has run out. This has to stop within a few seconds. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.i(TAG, "Android has ended this foreground service for today")
        blockForAWhile(this)
        holder?.let { EngineHost.end(it) }
        holder = null
        if (Prefs(this).enabled) SyncScheduler.scheduleResume(this, 0)
        stopSelf()
    }

    override fun onDestroy() {
        running = null
        holder?.let { EngineHost.end(it) }
        holder = null
        wakeLock?.takeIf { it.isHeld }?.release()
        wifiLock?.takeIf { it.isHeld }?.release()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "TelePhoto"
        private val BLOCKED_MS = TimeUnit.HOURS.toMillis(6)
        private var running: SyncService? = null

        val isRunning get() = running != null

        private fun blockForAWhile(context: Context) {
            Prefs(context).foregroundBlockedUntil = System.currentTimeMillis() + BLOCKED_MS
        }

        /** True if the service is running or now on its way. False means Android will not allow it right now. */
        fun tryStart(context: Context): Boolean {
            if (running != null) {
                EngineHost.requestRun()
                return true
            }
            val prefs = Prefs(context)
            if (!prefs.enabled) return false
            // The screen being open lifts the block, as Android always allows it then.
            if (System.currentTimeMillis() < prefs.foregroundBlockedUntil && EngineHost.activity == null) return false
            return try {
                context.startForegroundService(Intent(context, SyncService::class.java))
                true
            } catch (e: IllegalStateException) {
                // This includes ForegroundServiceStartNotAllowedException, which only exists from Android 12.
                Log.i(TAG, "Android will not start a foreground service now: ${e.message}")
                false
            } catch (e: SecurityException) {
                Log.w(TAG, "Android will not start a foreground service", e)
                false
            }
        }

        fun update(status: JSONObject) {
            val service = running ?: return
            SyncNotifications.showProgress(service, status)
        }
    }
}
