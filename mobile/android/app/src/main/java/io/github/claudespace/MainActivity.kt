package io.github.claudespace

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    private var permissionResult: ((Boolean) -> Unit)? = null

    // Android's own permission dialog, registered before the activity starts (an activity result contract)
    private val notifyPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            permissionResult?.invoke(granted)
            permissionResult = null
        }

    /** the page's theme (BridgePlugin, ui.theme), applied again on resume: Capacitor's SystemBars resets the bars then */
    private var theme: Pair<Boolean, Int>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(BridgePlugin::class.java)
        super.onCreate(savedInstanceState)
        // screens are browser history entries (src/mobile/store.ts): back closes a chat or the settings first
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val web = bridge?.webView
                if (web != null && web.canGoBack()) {
                    web.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })
    }

    override fun onResume() {
        super.onResume()
        theme?.let { (dark, color) -> paintBars(dark, color) }
    }

    fun applyTheme(dark: Boolean, background: String) {
        val color = runCatching { Color.parseColor(background) }.getOrDefault(if (dark) 0xFF121110.toInt() else 0xFFFBFAF8.toInt())
        theme = dark to color
        paintBars(dark, color)
    }

    private fun paintBars(dark: Boolean, color: Int) {
        window.decorView.setBackgroundColor(color)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    fun notificationsAllowed(): Boolean {
        val permitted = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        return permitted && NotificationManagerCompat.from(this).areNotificationsEnabled()
    }

    /** Asks for POST_NOTIFICATIONS (Android 13+); the answer comes to `done`. Older Android has nothing to ask. */
    fun askNotifications(done: (Boolean) -> Unit) {
        if (Build.VERSION.SDK_INT < 33) return done(notificationsAllowed())
        permissionResult = done
        notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
}
