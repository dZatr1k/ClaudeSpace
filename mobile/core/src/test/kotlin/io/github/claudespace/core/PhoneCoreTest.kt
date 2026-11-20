package io.github.claudespace.core

import java.io.File
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.io.encoding.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.TestMethodOrder

// PhoneCore end to end, the way the Android service drives it: bridge channels in, events out. Over real SSH (MINA,
// fake HOME, the real agent, a test tmux socket), with the phone's key from a FileKeyVault.
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class PhoneCoreTest {
    private lateinit var fh: FakeHome
    private lateinit var dir: File
    private lateinit var server: TestSshd
    private lateinit var core: PhoneCore
    private val events = CopyOnWriteArrayList<Pair<String, JsonElement>>()
    private val turns = CopyOnWriteArrayList<TurnDone>()

    @BeforeAll
    fun setup() {
        killTmux()
        fh = FakeHome.create()
        dir = Files.createTempDirectory("cs-phone-").toFile()
        val vault = FileKeyVault(File(dir, "phone_key"))
        server = TestSshd(fh.home, vault.loadOrCreate().publicOpenSsh)
        core = PhoneCore(dir, Env.bundle, vault, tmuxSocket = Env.tmuxSocket)
        core.events = object : PhoneEvents {
            override fun event(name: String, data: JsonElement) {
                events += name to data
            }
            override fun turn(t: TurnDone) {
                turns += t
            }
            override fun log(line: String) {
                if (System.getenv("CS_DEBUG") != null) System.err.println(line)
            }
        }
        core.start()
    }

    @AfterAll
    fun cleanup() {
        core.shutdown()
        server.close()
        killTmux()
        fh.close()
        dir.deleteRecursively()
    }

    private fun call(channel: String, args: String = "{}"): JsonElement =
        runBlocking { core.invoke(channel, Json.parseToJsonElement(args)) }

    private fun kind(s: JsonElement) = s.jsonObject["kind"]!!.jsonPrimitive.content

    private fun lastState() = events.lastOrNull { it.first == "conn.state" }?.second

    @Test
    @Order(1)
    fun `before settings - needs-user config, the phone key, default settings`() {
        val st = call("conn.state").jsonObject
        assertEquals("needs-user", kind(st))
        assertEquals("config", st["reason"]!!.jsonPrimitive.content)
        val key = call("key.get").jsonObject
        assertTrue(key["publicKey"]!!.jsonPrimitive.content.startsWith("ssh-ed25519 "))
        assertEquals(core.key.fingerprint, key["fingerprint"]!!.jsonPrimitive.content)
        assertEquals(PhoneSettings().toJson(), call("settings.get"))
        assertEquals(JsonArray(emptyList()), call("events.replay"))
    }

    @Test
    @Order(2)
    fun `settings connect - host key prompt, trust, online, lists replayed`() {
        val saved = call("settings.set", """{"connection":{"host":"127.0.0.1","port":${server.port},"user":"tester"}}""")
        assertEquals("127.0.0.1", saved.jsonObject["connection"]!!.jsonObject["host"]!!.jsonPrimitive.content)
        assertTrue(events.any { it.first == "settings.changed" })
        val hk = waitFor("hostkey-new", 15_000) {
            lastState()?.takeIf { kind(it) == "needs-user" && it.jsonObject["reason"]?.jsonPrimitive?.content == "hostkey-new" }
        }
        assertEquals("127.0.0.1:${server.port}", hk.jsonObject["host"]!!.jsonPrimitive.content)
        call("conn.trustHost", """{"accept":true}""")
        waitFor("online", 20_000) { lastState()?.takeIf { kind(it) == "online" } }
        // a UI that opens now gets hello first, then the lists
        val replay = waitFor("lists") {
            call("events.replay").jsonArray.takeIf { r -> r.any { it.jsonObject["event"]!!.jsonPrimitive.content == "projects_changed" } }
        }
        assertEquals("hello", replay.first().jsonObject["event"]!!.jsonPrimitive.content)
        val chats = replay.first { it.jsonObject["event"]!!.jsonPrimitive.content == "chats_changed" }
            .jsonObject["data"]!!.jsonObject["full"]!!.jsonArray
        assertTrue(chats.size > 3)
        assertEquals(fh.alpha.path, core.chatProject("11111111-1111-4111-8111-111111111111"))
    }

    @Test
    @Order(3)
    fun `agent calls pass through, methods only the desktop main may call are refused`() {
        val ok = call("agent.call", """{"method":"list_chats","params":{}}""").jsonObject
        assertTrue(ok["ok"]!!.jsonPrimitive.boolean)
        assertTrue(ok["result"]!!.jsonObject["chats"]!!.jsonArray.size > 3)
        for (m in listOf("winfs_mount", "askpass_reply", "Bad-Name", "x".repeat(41))) {
            val r = call("agent.call", """{"method":"$m","params":{}}""").jsonObject
            assertFalse(r["ok"]!!.jsonPrimitive.boolean, m)
            assertEquals("bad_request", r["error"]!!.jsonObject["code"]!!.jsonPrimitive.content)
        }
        val badParams = call("agent.call", """{"method":"list_chats","params":[1]}""").jsonObject
        assertEquals("bad_request", badParams["error"]!!.jsonObject["code"]!!.jsonPrimitive.content)
        // the agent's own errors come back as they are
        val err = call("agent.call", """{"method":"session_preview","params":{"session":"x y"}}""").jsonObject
        assertFalse(err["ok"]!!.jsonPrimitive.boolean)
    }

    @Test
    @Order(4)
    fun `a terminal - output as base64 events, input, the turn of its Claude`() {
        val ns = call("agent.call", """{"method":"new_session","params":{"cwd":"${fh.alpha.path}"}}""").jsonObject
        val session = ns["result"]!!.jsonObject["session"]!!.jsonPrimitive.content
        assertEquals(
            JsonObject(mapOf("ok" to JsonPrimitive(true))),
            call("term.open", """{"tabId":"m1","kind":"tmux","session":"$session","cols":60,"rows":20}"""),
        )
        fun text() = events.filter { it.first == "term.data" && it.second.jsonObject["tabId"]!!.jsonPrimitive.content == "m1" }
            .joinToString("") { Base64.decode(it.second.jsonObject["data64"]!!.jsonPrimitive.content).decodeToString() }
        waitFor("claude output") { text().contains("fake claude") }
        call("term.write", """{"tabId":"m1","data":"привет\r"}""")
        waitFor("echo") { text().contains("привет") }
        assertEquals(
            "неверные параметры терминала",
            call("term.open", """{"tabId":"bad id","kind":"tmux","session":"$session","cols":60,"rows":20}""")
                .jsonObject["error"]!!.jsonPrimitive.content,
        )

        // the user's Claude Code hook writes a turn; the agent maps it to the session, the core passes it on
        registerClaude(fh, session, "11111111-1111-4111-8111-111111111111")
        waitFor("session list with the chat") {
            call("agent.call", """{"method":"list_active","params":{}}""").toString().contains("11111111-1111-4111-8111-111111111111")
        }
        File(fh.home, ".cache/claudespace/events.jsonl").appendText(
            """{"ts":${System.currentTimeMillis()},"kind":"input","sessionId":"11111111-1111-4111-8111-111111111111","cwd":"${fh.alpha.path}","body":"Разрешить?"}""" + "\n",
        )
        val t = waitFor("turn") { turns.firstOrNull() }
        assertEquals(TurnDone(t.ts, "input", "11111111-1111-4111-8111-111111111111", session, fh.alpha.path, null, "Разрешить?"), t)
        val notice = TurnNotices().notice(t, appVisible = false, chatProject = core.chatProject(t.chatId))!!
        assertEquals("Alpha: Claude ждёт ввода", notice.title)

        call("term.close", """{"tabId":"m1"}""")
        call("agent.call", """{"method":"kill_session","params":{"session":"$session"}}""")
    }

    @Test
    @Order(5)
    fun `a file from the phone lands in the VM cache under its name, an image as an attachment`() {
        val r = call("attach.upload", """{"name":"photo notes.md","data64":"${Base64.encode("# notes".toByteArray())}"}""").jsonObject
        assertTrue(r["ok"]!!.jsonPrimitive.boolean, r.toString())
        val path = r["path"]!!.jsonPrimitive.content
        assertTrue(Regex("^${Regex.escape(fh.home.path)}/\\.cache/claudespace/files/[0-9a-f]{16}/photo_notes\\.md$").matches(path), path)
        assertEquals("# notes", File(path).readText())
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)
        val img = call("attach.upload", """{"name":"x.bin","data64":"${Base64.encode(png)}"}""").jsonObject
        assertTrue(Regex("/\\.cache/claudespace/images/img-[0-9a-f]{16}\\.png$").containsMatchIn(img["path"]!!.jsonPrimitive.content))
    }

    @Test
    @Order(6)
    fun `forgetting the host key, then new settings reconnect`() {
        val kh = File(dir, "known_hosts")
        assertTrue(kh.readText().contains("]:${server.port} "))
        call("conn.forgetHost")
        assertFalse(kh.readText().contains("]:${server.port} "))
        val n = events.size
        call("settings.set", """{"connection":{"user":"other"}}""")
        // the key is gone and the connection restarts: the server key is asked for again
        waitFor("asks again", 15_000) {
            events.drop(n).lastOrNull { it.first == "conn.state" }?.second?.takeIf {
                it.jsonObject["reason"]?.jsonPrimitive?.content == "hostkey-new"
            }
        }
        call("settings.set", """{"connection":{"host":""}}""")
        assertEquals("config", call("conn.state").jsonObject["reason"]!!.jsonPrimitive.content)
        try {
            call("nope")
            error("an unknown channel must throw")
        } catch (_: IllegalArgumentException) {
        }
    }
}

/** Claude registered for the pane of a session (the agent reads ~/.claude/sessions), like the desktop e2e does. */
fun registerClaude(fh: FakeHome, session: String, chatId: String, status: String = "idle") {
    val (paneId, panePid) = tmux("list-panes", "-t", "=$session", "-F", "#{pane_id} #{pane_pid}").trim().split(" ")
    val procStart = File("/proc/$panePid/stat").readText().substringAfterLast(')').trim().split(" ")[19]
    File(fh.home, ".claude/sessions/$panePid.json").writeText(
        """{"pid":$panePid,"sessionId":"$chatId","cwd":"${fh.alpha.path}","procStart":"$procStart","status":"$status",""" +
            """"statusUpdatedAt":${System.currentTimeMillis()},"tmux":"$session:@1.$paneId"}""",
    )
}
