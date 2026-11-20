package io.github.claudespace

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import io.github.claudespace.core.PhoneEvents
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/**
 * The bridge of src/shared/mobile.ts (the web part's nativeBridge.ts) in front of CoreService. Arguments, results and
 * events cross as JSON text. Everything that reaches the WebView is posted on the main thread, in order.
 */
@CapacitorPlugin(
    name = "ClaudeSpace",
    permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")],
)
class BridgePlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var service = CompletableDeferred<CoreService>()
    @Volatile private var bound: CoreService? = null

    private val events = object : PhoneEvents {
        override fun event(name: String, data: JsonElement) = emit(name, data)
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val s = (binder as CoreService.LocalBinder).service
            s.ui = events
            s.appVisible = true
            s.applyBackground()
            bound = s
            service.complete(s)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            bound = null
            service = CompletableDeferred()
        }
    }

    override fun load() {
        context.bindService(Intent(context, CoreService::class.java), connection, Context.BIND_AUTO_CREATE)
        activity?.intent?.let { openFromNotification(it) }
    }

    private fun emit(name: String, data: JsonElement, retain: Boolean = false) {
        val o = JSObject().put("event", name).put("json", data.toString())
        main.post { notifyListeners("event", o, retain) }
    }

    /** a tapped notification: the web part opens the chat (kept until its listener is there on a cold start) */
    private fun openFromNotification(intent: Intent) {
        val session = intent.getStringExtra(Notifications.EXTRA_SESSION) ?: return
        val chatId = intent.getStringExtra(Notifications.EXTRA_CHAT)
        intent.removeExtra(Notifications.EXTRA_SESSION)
        intent.removeExtra(Notifications.EXTRA_CHAT)
        emit("notify.click", buildJsonObject {
            put("session", JsonPrimitive(session))
            put("chatId", chatId?.let { JsonPrimitive(it) } ?: JsonNull)
        }, retain = true)
    }

    override fun handleOnNewIntent(intent: Intent) = openFromNotification(intent)

    override fun handleOnResume() {
        bound?.appVisible = true
    }

    override fun handleOnPause() {
        bound?.appVisible = false
    }

    override fun handleOnDestroy() {
        bound?.let {
            it.ui = null
            it.appVisible = false
        }
        runCatching { context.unbindService(connection) }
        scope.cancel()
    }

    private fun resolve(call: PluginCall, result: JsonElement) =
        main.post { call.resolve(JSObject().put("json", result.toString())) }

    @PluginMethod
    fun invoke(call: PluginCall) {
        val channel = call.getString("channel") ?: return call.reject("no channel")
        val args = try {
            Json.parseToJsonElement(call.getString("json") ?: "{}")
        } catch (_: Exception) {
            return call.reject("bad arguments")
        }
        when (channel) {
            "launch.openExternal" -> openExternal(call, args)
            "notify.permission" -> permission(call, args)
            else -> scope.launch {
                try {
                    resolve(call, service.await().core.invoke(channel, args))
                } catch (e: Exception) {
                    main.post { call.reject(e.message ?: e.toString()) }
                }
            }
        }
    }

    private fun openExternal(call: PluginCall, args: JsonElement) {
        val url = (args.jsonObject["url"] as? JsonPrimitive)?.contentOrNull
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return call.reject("bad url")
        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        resolve(call, JsonNull)
    }

    private fun permissionState(): String = when {
        Build.VERSION.SDK_INT < 33 ->
            if (NotificationManagerCompat.from(context).areNotificationsEnabled()) "granted" else "denied"
        else -> when (getPermissionState("notifications")) {
            PermissionState.GRANTED -> "granted"
            PermissionState.DENIED -> "denied"
            else -> "prompt"
        }
    }

    private fun permission(call: PluginCall, args: JsonElement) {
        val request = (args.jsonObject["request"] as? JsonPrimitive)?.contentOrNull == "true"
        if (request && permissionState() == "prompt") requestPermissionForAlias("notifications", call, "onPermission")
        else resolve(call, JsonPrimitive(permissionState()))
    }

    @PermissionCallback
    private fun onPermission(call: PluginCall) = resolve(call, JsonPrimitive(permissionState()))
}
