package io.github.claudespace.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/** The end of a Claude turn, as the agent reports it (`turn_done`, TurnDone in src/shared/protocol.ts). */
data class TurnDone(
    val ts: Long,
    /** "done" or "input" (waits for an answer or a permission) */
    val kind: String,
    val chatId: String?,
    val session: String?,
    val cwd: String?,
    val project: String?,
    val body: String,
) {
    companion object {
        fun parse(data: JsonElement): TurnDone? {
            val o = data as? JsonObject ?: return null
            fun s(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
            val kind = s("kind")?.takeIf { it == "done" || it == "input" } ?: return null
            val ts = (o["ts"] as? JsonPrimitive)?.longOrNull ?: return null
            return TurnDone(ts, kind, s("chatId"), s("session"), s("cwd"), s("project"), s("body") ?: "")
        }
    }
}

/** An Android notification for a turn: what it says and which chat a tap opens. */
data class Notice(val key: String, val title: String, val body: String, val session: String?, val chatId: String?)

/**
 * Which turns become notifications (the desktop's notifier.ts, for a phone). While the app is on screen it shows a
 * toast itself, so only a hidden app gets a notification. Each turn once.
 */
class TurnNotices {
    private val seen = LinkedHashSet<String>()

    /** chatProject: the project folder of the chat (from the chat list), the best name for it */
    fun notice(t: TurnDone, appVisible: Boolean, chatProject: String?): Notice? {
        val key = "${t.chatId}:${t.ts}"
        synchronized(seen) {
            if (!seen.add(key)) return null
            if (seen.size > 200) seen.remove(seen.first())
        }
        if (appVisible) return null
        val path = chatProject ?: t.cwd
        val name = path?.trimEnd('/')?.substringAfterLast('/')?.ifEmpty { null } ?: t.project ?: t.session ?: "Claude"
        val input = t.kind == "input"
        return Notice(
            key = key,
            title = if (input) "$name: Claude ждёт ввода" else "$name: Claude ответил",
            body = t.body.ifBlank { if (input) "Нужен ваш ответ или разрешение" else "Нажмите, чтобы открыть чат" },
            session = t.session,
            chatId = t.chatId,
        )
    }
}
