package io.github.claudespace

import android.app.Service
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import io.github.claudespace.core.ConnState
import io.github.claudespace.core.PhoneCore
import io.github.claudespace.core.PhoneEvents
import io.github.claudespace.core.PhoneSettings
import io.github.claudespace.core.SshTransport
import io.github.claudespace.core.TurnDone
import io.github.claudespace.core.TurnNotices
import java.io.File
import kotlinx.serialization.json.JsonElement

/**
 * Holds the phone core (mobile/core PhoneCore) for as long as the app needs it. Bound by the bridge plugin while the
 * app is open; with «Держать связь в фоне» on it is also started in the foreground, so the connection and Claude's
 * notifications stay when the app is closed. The UI talks to it only through the plugin.
 */
class CoreService : Service() {
    inner class LocalBinder : Binder() {
        val service: CoreService
            get() = this@CoreService
    }

    private val binder = LocalBinder()
    lateinit var core: PhoneCore
        private set
    private val notices = TurnNotices()
    private val debuggable by lazy { (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 }
    private var foreground = false
    private var linkText = ""

    /** the bridge plugin while the app is open: UI events go there */
    @Volatile var ui: PhoneEvents? = null
    /** the app is on screen: it shows Claude's turns itself */
    @Volatile var appVisible = false

    override fun onCreate() {
        super.onCreate()
        Notifications.createChannels(this)
        SshTransport.installSecurity()
        core = PhoneCore(
            dataDir = File(filesDir, "core"),
            bundle = AssetBundle(assets),
            vault = KeystoreVault(File(filesDir, "phone_key.enc"), "ClaudeSpace ${Build.MODEL}"),
        )
        core.events = object : PhoneEvents {
            override fun event(name: String, data: JsonElement) {
                ui?.event(name, data)
            }

            override fun state(s: ConnState) = updateLink(s)

            override fun turn(t: TurnDone) {
                val n = notices.notice(t, appVisible, core.chatProject(t.chatId))
                when {
                    n == null -> core.note("[app] turn ${t.kind} ${t.session ?: "-"}: the app is open, no notification")
                    else -> core.note("[app] turn ${t.kind} ${t.session ?: "-"}: ${Notifications.turn(this@CoreService, n)}")
                }
            }

            override fun settings(s: PhoneSettings) = applyBackground(s)

            override fun log(line: String) {
                if (debuggable) Log.d("ClaudeSpace", line)
            }
        }
        core.start()
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!core.settings.background) {
            stopSelf()
            return START_NOT_STICKY
        }
        goForeground()
        return START_STICKY
    }

    private fun goForeground() {
        if (foreground) return
        linkText = Notifications.linkText(core.state())
        try {
            ServiceCompat.startForeground(
                this,
                Notifications.ID_LINK,
                Notifications.link(this, linkText),
                if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
            )
            foreground = true
            core.note("[app] background connection on (foreground service)")
        } catch (e: Exception) {
            // Android refuses a foreground start from the background (a restart after the system killed us)
            core.note("[app] foreground service refused: $e")
            stopSelf()
        }
    }

    /** the background switch: start or stop being a foreground service; while bound the service stays either way */
    fun applyBackground(s: PhoneSettings = core.settings) {
        if (s.background) {
            ContextCompat.startForegroundService(this, Intent(this, CoreService::class.java))
        } else if (foreground) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            foreground = false
            core.note("[app] background connection off")
            stopSelf()
        }
    }

    private fun updateLink(s: ConnState) {
        if (!foreground) return
        val text = Notifications.linkText(s)
        if (text == linkText) return
        linkText = text
        try {
            NotificationManagerCompat.from(this).notify(Notifications.ID_LINK, Notifications.link(this, text))
        } catch (_: SecurityException) {
            // no notification permission: the service still runs, Android shows it in the task manager
        }
    }

    override fun onDestroy() {
        core.shutdown()
        super.onDestroy()
    }
}
