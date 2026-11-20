package io.github.claudespace.core

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** Connection state; toJson() has the shape of ConnState in src/shared/model.ts, so the UI code stays shared. */
sealed class ConnState {
    abstract fun toJson(): JsonObject

    enum class Step(val wire: String) { CONFIG("config"), AUTH("auth"), HOSTKEY("hostkey"), AGENT("agent") }

    /** the phone's subset of NeedsUserReason (no ssh-agent, no key passphrase) */
    enum class Reason(val wire: String) {
        CONFIG("config"),
        HOSTKEY_NEW("hostkey-new"),
        HOSTKEY_MISMATCH("hostkey-mismatch"),
        AUTH_REJECTED("auth-rejected"),
        AGENT_MISSING_DEPS("agent-missing-deps"),
    }

    data object Idle : ConnState() {
        override fun toJson() = buildJsonObject { put("kind", JsonPrimitive("idle")) }
    }

    data class Connecting(val step: Step, val attempt: Int, val detail: String? = null) : ConnState() {
        override fun toJson() = buildJsonObject {
            put("kind", JsonPrimitive("connecting"))
            put("step", JsonPrimitive(step.wire))
            put("attempt", JsonPrimitive(attempt))
            if (detail != null) put("detail", JsonPrimitive(detail))
        }
    }

    data class NeedsUser(
        val reason: Reason,
        val detail: String? = null,
        val fingerprint: String? = null,
        val host: String? = null,
    ) : ConnState() {
        override fun toJson() = buildJsonObject {
            put("kind", JsonPrimitive("needs-user"))
            put("reason", JsonPrimitive(reason.wire))
            if (detail != null) put("detail", JsonPrimitive(detail))
            if (fingerprint != null) put("fingerprint", JsonPrimitive(fingerprint))
            if (host != null) put("host", JsonPrimitive(host))
        }
    }

    data class Online(val since: Long, val rttMs: Long?, val agent: String, val host: String) : ConnState() {
        override fun toJson() = buildJsonObject {
            put("kind", JsonPrimitive("online"))
            put("since", JsonPrimitive(since))
            put("rttMs", rttMs?.let { JsonPrimitive(it) } ?: JsonNull)
            put("agent", JsonPrimitive(agent))
            put("host", JsonPrimitive(host))
        }
    }

    data class Offline(val since: Long, val retryAt: Long, val attempt: Int, val error: String) : ConnState() {
        override fun toJson() = buildJsonObject {
            put("kind", JsonPrimitive("offline"))
            put("since", JsonPrimitive(since))
            put("retryAt", JsonPrimitive(retryAt))
            put("attempt", JsonPrimitive(attempt))
            put("error", JsonPrimitive(error))
        }
    }
}
