package io.github.claudespace.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.supervisorScope
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class AgentRpcTest {
    private class Chan : ExecChannel {
        lateinit var l: ChannelListener
        val sent = java.util.concurrent.CopyOnWriteArrayList<String>()
        override fun start(listener: ChannelListener) {
            l = listener
        }
        override fun write(data: ByteArray) {
            sent += data.decodeToString()
        }
        override fun end() {}
        override fun close() {}
        override fun setWindow(cols: Int, rows: Int) {}
        override fun pause() {}
        override fun resume() {}
        fun lastId(): Long = kotlinx.serialization.json.Json.parseToJsonElement(sent.last()).jsonObject["id"]!!.jsonPrimitive.content.toLong()
    }

    private class Rec : RpcListener {
        val events = mutableListOf<Pair<String, JsonElement>>()
        val logs = mutableListOf<String>()
        var closed = false
        override fun event(name: String, data: JsonElement) {
            events += name to data
        }
        override fun log(line: String) {
            logs += line
        }
        override fun closed(code: Int?) {
            closed = true
        }
    }

    @Test
    fun `results by id, errors, events, lines split across chunks`() = runBlocking(Dispatchers.Default) { supervisorScope {
        val ch = Chan()
        val rec = Rec()
        val rpc = AgentRpc(ch, rec)
        rpc.start()
        val call = async { rpc.call("list_active", JsonObject(mapOf("x" to JsonPrimitive(1)))) }
        waitFor("request") { ch.sent.isNotEmpty() }
        val req = kotlinx.serialization.json.Json.parseToJsonElement(ch.sent.single()).jsonObject
        assertEquals("list_active", req["method"]!!.jsonPrimitive.content)
        assertEquals(1, req["params"]!!.jsonObject["x"]!!.jsonPrimitive.int)
        val id = ch.lastId()
        // an event and the response, cut in the middle of a multibyte character
        val bytes = "{\"event\":\"x\",\"data\":{\"t\":\"Привет\"}}\n{\"id\":$id,\"result\":{\"ok\":true}}\n".toByteArray()
        val cut = bytes.indexOfFirst { it == 0xd0.toByte() } + 1
        ch.l.data(bytes.copyOfRange(0, cut))
        ch.l.data(bytes.copyOfRange(cut, bytes.size))
        assertEquals("true", call.await().jsonObject["ok"]!!.jsonPrimitive.content)
        assertEquals("Привет", rec.events.single().second.jsonObject["t"]!!.jsonPrimitive.content)

        val bad = async { rpc.call("nope") }
        waitFor("request 2") { ch.sent.size == 2 }
        ch.l.data("{\"id\":${ch.lastId()},\"error\":{\"code\":\"bad_params\",\"message\":\"no\"}}\n".toByteArray())
        val e = assertFailsWith<RpcException> { bad.await() }
        assertEquals("bad_params", e.code)

        ch.l.data("not json\n".toByteArray())
        assertTrue(rec.logs.any { it.startsWith("rpc: bad JSON") })
    } }

    @Test
    fun `timeout, oversized line, close rejects pending calls`() = runBlocking(Dispatchers.Default) { supervisorScope {
        val ch = Chan()
        val rec = Rec()
        val rpc = AgentRpc(ch, rec)
        rpc.start()
        assertEquals("timeout", assertFailsWith<RpcException> { rpc.call("ping", timeoutMs = 50) }.code)

        ch.l.data(ByteArray(8 * 1024 * 1024 + 10) { 'a'.code.toByte() })
        ch.l.data("still the same line\n{\"event\":\"after\",\"data\":null}\n".toByteArray())
        assertTrue(rec.logs.contains("rpc: oversized line dropped"))
        assertEquals(listOf("after"), rec.events.map { it.first })

        val pending = async { rpc.call("list_chats") }
        waitFor("request") { ch.sent.size == 2 }
        ch.l.closed(0, null)
        assertEquals("closed", assertFailsWith<RpcException> { pending.await() }.code)
        assertTrue(rec.closed && rpc.isClosed)
        assertEquals("closed", assertFailsWith<RpcException> { rpc.call("ping") }.code)
    } }
}
