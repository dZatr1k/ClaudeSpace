package io.github.claudespace.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

const val FONT_MIN = 9
const val FONT_MAX = 18

/** The phone's settings; the JSON is MobileSettings of src/shared/mobile.ts (keep both in step). */
data class PhoneSettings(
    val host: String = "",
    val port: Int = 22,
    val user: String = "",
    val theme: String = "system",
    val fontSize: Int = 12,
    /** keep the connection in a foreground service: notifications also while the app is closed */
    val background: Boolean = true,
) {
    val configured: Boolean
        get() = host.isNotBlank() && user.isNotBlank()

    fun toJson(): JsonObject = buildJsonObject {
        put("connection", buildJsonObject {
            put("host", JsonPrimitive(host))
            put("port", JsonPrimitive(port))
            put("user", JsonPrimitive(user))
        })
        put("appearance", buildJsonObject {
            put("theme", JsonPrimitive(theme))
            put("fontSize", JsonPrimitive(fontSize))
        })
        put("notifications", buildJsonObject { put("background", JsonPrimitive(background)) })
    }

    /** Apply a MobileSettingsPatch; values of the wrong type or out of range are dropped (the UI is not trusted). */
    fun merge(patch: JsonObject): PhoneSettings {
        val c = patch["connection"] as? JsonObject
        val a = patch["appearance"] as? JsonObject
        val n = patch["notifications"] as? JsonObject
        fun str(o: JsonObject?, k: String) = (o?.get(k) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        fun int(o: JsonObject?, k: String) = (o?.get(k) as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
        return copy(
            host = str(c, "host")?.trim()?.take(253) ?: host,
            port = int(c, "port")?.takeIf { it in 1..65535 } ?: port,
            user = str(c, "user")?.trim()?.take(64) ?: user,
            theme = str(a, "theme")?.takeIf { it in setOf("system", "dark", "light") } ?: theme,
            fontSize = int(a, "fontSize")?.takeIf { it in FONT_MIN..FONT_MAX } ?: fontSize,
            background = (n?.get("background") as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: background,
        )
    }

    fun save(file: File) {
        file.parentFile?.mkdirs()
        val tmp = File(file.path + ".tmp")
        tmp.writeText(toJson().toString())
        if (!tmp.renameTo(file)) {
            file.writeText(tmp.readText())
            tmp.delete()
        }
    }

    companion object {
        fun load(file: File): PhoneSettings = try {
            PhoneSettings().merge(Json.parseToJsonElement(file.readText()).jsonObject)
        } catch (_: Exception) {
            PhoneSettings()
        }
    }
}
