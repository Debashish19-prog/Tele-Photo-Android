package app.telephoto

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.os.PowerManager
import android.provider.MediaStore
import java.util.concurrent.TimeUnit
import kotlin.math.max

/** Decides when Android wakes the app. All of these are only asked for while auto backup is on. */
object SyncScheduler {
    /** Fires when anything changes in the gallery, and has to be set up again after each time. */
    const val JOB_NEW_PHOTOS = 1
    /** A safety net, for anything missed, and the only one of these that survives a reboot by itself. */
    const val JOB_PERIODIC = 2
    /** Carries on later, once there is Wi-Fi or Telegram's requested wait is over. */
    const val JOB_RESUME = 3

    private val PERIOD_MS = TimeUnit.HOURS.toMillis(6)
    private val PERIOD_FLEX_MS = TimeUnit.HOURS.toMillis(2)
    private val RESUME_MIN_MS = TimeUnit.MINUTES.toMillis(1)
    private val NEW_PHOTO_DELAY_MS = TimeUnit.SECONDS.toMillis(5)
    private val NEW_PHOTO_MAX_DELAY_MS = TimeUnit.MINUTES.toMillis(1)

    private fun scheduler(context: Context) = context.getSystemService(JobScheduler::class.java)
    private fun component(context: Context) = ComponentName(context, SyncJob::class.java)

    private fun networkFor(context: Context) =
        if (Prefs(context).mobileData) JobInfo.NETWORK_TYPE_ANY else JobInfo.NETWORK_TYPE_UNMETERED

    /** Brings Android's list of jobs in line with the settings. Safe to call at any time. */
    fun arm(context: Context) {
        val jobs = scheduler(context)
        if (!Prefs(context).enabled) {
            jobs.cancelAll()
            return
        }
        armNewPhotos(context)
        jobs.schedule(
            JobInfo.Builder(JOB_PERIODIC, component(context))
                .setRequiredNetworkType(networkFor(context))
                .setPersisted(true)
                .setPeriodic(PERIOD_MS, PERIOD_FLEX_MS)
                .build(),
        )
    }

    fun armNewPhotos(context: Context) {
        if (!Prefs(context).enabled) return
        scheduler(context).schedule(
            JobInfo.Builder(JOB_NEW_PHOTOS, component(context))
                .addTriggerContentUri(
                    JobInfo.TriggerContentUri(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS),
                )
                .setTriggerContentUpdateDelay(NEW_PHOTO_DELAY_MS)
                .setTriggerContentMaxDelay(NEW_PHOTO_MAX_DELAY_MS)
                .setRequiredNetworkType(networkFor(context))
                .build(),
        )
    }

    /** @param at the time to resume, or 0 for as soon as sensible. */
    fun scheduleResume(context: Context, at: Long) {
        scheduler(context).schedule(
            JobInfo.Builder(JOB_RESUME, component(context))
                .setMinimumLatency(max(RESUME_MIN_MS, at - System.currentTimeMillis()))
                .setRequiredNetworkType(networkFor(context))
                .setPersisted(true)
                .build(),
        )
    }

    fun isBatteryExempt(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)
}
