package io.github.claudespace.core

import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** An agent error (its `error` object), or a local one: offline, timeout, closed. */
class RpcException(val code: String, message: String, val data: JsonElement? = null) : Exception(message) {
    fun toJson(): JsonObject = buildJsonObject {
        put("code", JsonPrimitive(code))
        put("message", JsonPrimitive(message))
        if (data != null) put("data", data)
    }
}

interface RpcListener {
    /** an agent event; called on the channel's reader thread, in order */
    fun event(name: String, data: JsonElement) {}
    /** the agent's stderr and protocol noise */
    fun log(line: String) {}
    fun closed(code: Int?) {}
}

/**
 * JSON Lines RPC over the agent's exec channel (a port of src/main/agent/rpc.ts): requests with timeouts, responses
 * matched by id, events. The core does not interpret methods: params and results pass through as JSON.
 */
class AgentRpc(private val ch: ExecChannel, private val listener: RpcListener) {
    private val nextId = AtomicLong(1)
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<JsonElement>>()
    private val closed = AtomicBoolean(false)
    private val buf = ByteArrayOutputStream()
    private var dropping = false

    val isClosed: Boolean
        get() = closed.get()

    fun start() {
        ch.start(object : ChannelListener {
            override fun data(b: ByteArray) = onData(b)
            override fun stderr(b: ByteArray) = listener.log(b.toString(Charsets.UTF_8))
            override fun closed(code: Int?, signal: String?) = onClose(code)
        })
    }

    private fun onData(b: ByteArray) {
        var from = 0
        for (i in b.indices) {
            if (b[i] != NL) continue
            if (!dropping) buf.write(b, from, i - from)
            val line = buf.toString(Charsets.UTF_8)
            buf.reset()
            if (!dropping && line.isNotBlank()) onLine(line)
            dropping = false
            from = i + 1
        }
        if (!dropping) buf.write(b, from, b.size - from)
        if (buf.size() > MAX_LINE) {
            listener.log("rpc: oversized line dropped")
            buf.reset()
            dropping = true
        }
    }

    private fun onLine(line: String) {
        val msg = try {
            Json.parseToJsonElement(line).jsonObject
        } catch (_: Exception) {
            listener.log("rpc: bad JSON: ${line.take(200)}")
            return
        }
        val event = (msg["event"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (event != null) {
            listener.event(event, msg["data"] ?: kotlinx.serialization.json.JsonNull)
            return
        }
        val error = msg["error"] as? JsonObject
        val id = (msg["id"] as? JsonPrimitive)?.longOrNull
        if (id == null) {
            if (error != null) listener.log("rpc: error without id: ${error["code"]} ${error["message"]}")
            return
        }
        val p = pending.remove(id) ?: return
        if (error != null) {
            p.completeExceptionally(
                RpcException(
                    error["code"]?.jsonPrimitive?.contentOrNull ?: "error",
                    error["message"]?.jsonPrimitive?.contentOrNull ?: "",
                    error["data"],
                ),
            )
        } else {
            p.complete(msg["result"] ?: kotlinx.serialization.json.JsonNull)
        }
    }

    private fun onClose(code: Int?) {
        if (!closed.compareAndSet(false, true)) return
        for (p in pending.values) p.completeExceptionally(RpcException("closed", "соединение с агентом закрыто"))
        pending.clear()
        listener.closed(code)
    }

    suspend fun call(method: String, params: JsonElement = JsonObject(emptyMap()), timeoutMs: Long = 10_000): JsonElement {
        if (closed.get()) throw RpcException("closed", "нет связи с агентом")
        val id = nextId.getAndIncrement()
        val d = CompletableDeferred<JsonElement>()
        pending[id] = d
        try {
            val line = buildJsonObject {
                put("id", JsonPrimitive(id))
                put("method", JsonPrimitive(method))
                put("params", params)
            }.toString() + "\n"
            withContext(Dispatchers.IO) { ch.write(line.toByteArray()) }
            if (closed.get()) d.completeExceptionally(RpcException("closed", "соединение с агентом закрыто"))
            return withTimeoutOrNull(timeoutMs) { d.await() }
                ?: throw RpcException("timeout", "агент не ответил за ${Math.round(timeoutMs / 1000.0)} с ($method)")
        } finally {
            pending.remove(id)
        }
    }

    fun close() {
        ch.end()
        ch.close()
    }

    private companion object {
        const val NL = '\n'.code.toByte()
        const val MAX_LINE = 8 * 1024 * 1024
    }
}
