package app.telephoto

import android.app.job.JobParameters
import android.app.job.JobService
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * What Android calls when the gallery changes, or when it is time to look again.
 *
 * It hands over to the foreground service if it can, because that has no time limit worth worrying
 * about. If Android will not allow one, it does the work here instead, in the roughly ten minutes a
 * job gets, and carries on in the next one.
 */
class SyncJob : JobService() {
    private val running = HashMap<Int, PassHolder>()
    private val main = Handler(Looper.getMainLooper())

    /**
     * The "gallery changed" job only fires once, so it has to be set up again. Doing that while it is
     * still running would stop it, because Android treats scheduling an id as replacing that job.
     */
    private fun armAgainAfterThis() {
        main.postDelayed({ SyncScheduler.armNewPhotos(applicationContext) }, 1000)
    }

    override fun onStartJob(params: JobParameters): Boolean {
        if (!Prefs(this).enabled) return false

        if (SyncService.tryStart(this)) {
            armAgainAfterThis()
            return false
        }

        Log.i("TelePhoto", "Running this backup pass inside a job, as a foreground service is not allowed now")
        val holder = PassHolder {
            running.remove(params.jobId)
            jobFinished(params, false)
            armAgainAfterThis()
        }
        running[params.jobId] = holder
        EngineHost.begin(this, holder)
        // Something new has turned up, and the pass already running would not have seen it.
        if (EngineHost.isPassActive) EngineHost.requestRun()
        return true
    }

    /** Android wants its time back. Returning true asks for this job to run again later. */
    override fun onStopJob(params: JobParameters): Boolean {
        running.remove(params.jobId)?.let { EngineHost.end(it) }
        armAgainAfterThis()
        return true
    }
}
