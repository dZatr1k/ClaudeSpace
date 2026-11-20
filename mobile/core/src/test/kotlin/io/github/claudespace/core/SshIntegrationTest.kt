package io.github.claudespace.core

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.TestMethodOrder

// End to end over real SSH (MINA SSHD on 127.0.0.1, fake HOME, the real agent, a test tmux socket): host key TOFU,
// agent install over SFTP and the installPlan rule, agent RPC and events, --app and CLAUDESPACE_APP, a tmux terminal
// on a PTY with resize and flow control, reconnect after a network drop and after a keepalive timeout.
// Nothing touches ~/.ssh, the user's tmux or the installed agent.
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class SshIntegrationTest {
    private lateinit var fh: FakeHome
    private lateinit var dir: File
    private lateinit var server: TestSshd
    private val key = SshKey.generate("phone-test")
    private val manifestFile get() = File(fh.home, "$REMOTE_DIR/MANIFEST.json")

    @BeforeAll
    fun setup() {
        killTmux()
        fh = FakeHome.create()
        dir = Files.createTempDirectory("cs-kt-").toFile()
        server = TestSshd(fh.home, key.publicOpenSsh)
    }

    @AfterAll
    fun cleanup() {
        server.close()
        killTmux()
        fh.close()
        dir.deleteRecursively()
    }

    private fun conn(keepaliveSec: Int = 15): Pair<Connection, Recorder> {
        val rec = Recorder()
        val c = Connection(
            config = { ConnectionConfig("127.0.0.1", server.port, "tester", key, keepaliveSec, Env.tmuxSocket) },
            bundle = Env.bundle,
            knownHostsFile = File(dir, "known_hosts"),
            listener = rec,
        )
        return c to rec
    }

    private fun Connection.callBlocking(method: String, params: Map<String, JsonElement> = emptyMap()): JsonElement =
        runBlocking { call(method, JsonObject(params), 10_000) }

    private fun online(c: Connection, what: String = "online") = waitFor(what, 20_000) { c.state is ConnState.Online }

    private fun fullChats(rec: Recorder, from: Int = 0) = waitFor("full chats snapshot") {
        rec.events.drop(from).firstOrNull { (n, d) -> n == "chats_changed" && (d as? JsonObject)?.get("full") != null }
    }

    @Test
    @Order(1)
    fun `asks to trust a new host key, then installs the agent over SFTP and goes online`() {
        val (c, rec) = conn()
        c.start()
        val hk = waitFor("needs-user", 15_000) { rec.firstAfter<ConnState.NeedsUser>() }
        assertEquals(ConnState.Reason.HOSTKEY_NEW, hk.reason)
        assertTrue(hk.fingerprint!!.startsWith("SHA256:"))
        assertEquals("127.0.0.1:${server.port}", hk.host)
        assertFalse(File(dir, "known_hosts").exists())
        c.trustHost(true)
        online(c)
        assertEquals(Env.bundleManifest.hash, Manifest.parse(manifestFile.readText()).hash)
        // modes as the PC's installer sets them: scripts 700, other files 600, folders 700
        fun mode(rel: String) = Files.getPosixFilePermissions(File(fh.home, "$REMOTE_DIR/$rel").toPath())
            .let { java.nio.file.attribute.PosixFilePermissions.toString(it) }
        assertEquals("rwx------", mode("csagent.py"))
        assertEquals("rwx------", mode("askpass.py"))
        assertEquals("rw-------", mode("cclib/route.py"))
        assertEquals("rwx------", mode("cclib"))
        assertEquals("rwx------", mode(""))
        assertTrue(Regex("^\\[127\\.0\\.0\\.1]:\\d+ ecdsa-sha2-nistp256 ").containsMatchIn(File(dir, "known_hosts").readText()))
        // the agent runs with this connection's app id; hello comes first, then the first snapshots
        assertTrue(server.execs.any { it.endsWith("serve --protocol 1 --app ${c.appId}") }, server.execs.last())
        assertEquals("hello", rec.events.first().first)
        fullChats(rec)
        waitFor("projects") { rec.events.any { it.first == "projects_changed" } }
        val chats = c.callBlocking("list_chats").jsonObject.getValue("chats").jsonArray
        assertTrue(chats.size > 3)
        assertTrue((c.state as ConnState.Online).host.contains("@"))
        c.stop()
        assertEquals(ConnState.Idle, c.state)
        assertEquals(ConnState.Idle, rec.states.last())
    }

    @Test
    @Order(2)
    fun `reuses the trusted key and the installed agent`() {
        val before = server.execs.size
        val (c, _) = conn()
        c.start()
        online(c)
        assertFalse(server.execs.drop(before).any { it.contains("claudespace.tmp-") })
        c.shutdown()
    }

    @Test
    @Order(3)
    fun `reinstalls when an installed file was changed`() {
        manifestFile.writeText(manifestFile.readText().replace(Env.bundleManifest.hash, "sha256:changed"))
        val (c, _) = conn()
        c.start()
        online(c)
        assertEquals(Env.bundleManifest.hash, Manifest.parse(manifestFile.readText()).hash)
        c.shutdown()
    }

    private fun setInstalled(app: String, protocol: Int) {
        val o = Json.parseToJsonElement(manifestFile.readText()).jsonObject.toMutableMap()
        o["app"] = JsonPrimitive(app)
        o["hash"] = JsonPrimitive("sha256:from-a-newer-app")
        o["protocol"] = JsonPrimitive(protocol)
        manifestFile.writeText(JsonObject(o).toString())
    }

    @Test
    @Order(4)
    fun `keeps an agent from a newer release, refuses one on another protocol`() {
        setInstalled("99.0.0", PROTOCOL)
        val logs = mutableListOf<String>()
        val rec = object : ConnectionListener {
            override fun log(line: String) {
                synchronized(logs) { logs += line }
            }
        }
        var c = Connection(
            { ConnectionConfig("127.0.0.1", server.port, "tester", key, 15, Env.tmuxSocket) },
            Env.bundle, File(dir, "known_hosts"), rec,
        )
        c.start()
        online(c)
        assertEquals("99.0.0", Manifest.parse(manifestFile.readText()).app)
        assertTrue(synchronized(logs) { logs.any { it.contains("newer release (99.0.0)") } })
        c.shutdown()

        setInstalled("99.0.0", PROTOCOL + 1)
        val r2 = Recorder()
        c = Connection(
            { ConnectionConfig("127.0.0.1", server.port, "tester", key, 15, Env.tmuxSocket) },
            Env.bundle, File(dir, "known_hosts"), r2,
        )
        c.start()
        val st = waitFor("needs-user", 15_000) { r2.firstAfter<ConnState.NeedsUser>() }
        assertEquals(ConnState.Reason.AGENT_MISSING_DEPS, st.reason)
        assertTrue(st.detail!!.contains("Обновите приложение"), st.detail)
        c.shutdown()
        File(fh.home, REMOTE_DIR).deleteRecursively()
    }

    @Test
    @Order(5)
    fun `terminal - tmux on an SSH PTY with CLAUDESPACE_APP, resize, detach, flow control`() {
        val (c, _) = conn()
        c.start()
        online(c)
        val session = c.callBlocking("new_session", mapOf("cwd" to JsonPrimitive(fh.alpha.path)))
            .jsonObject.getValue("session").jsonPrimitive.content
        assertTrue(session.startsWith("Alpha"))
        val out = mutableMapOf<String, ByteArrayOutputStream>()
        val exits = java.util.concurrent.CopyOnWriteArrayList<String>()
        val tm = TerminalManager(
            object : TerminalSink {
                override fun data(tabId: String, data: ByteArray) {
                    synchronized(out) { out.getOrPut(tabId) { ByteArrayOutputStream() }.write(data) }
                }
                override fun exit(tabId: String, code: Int?, signal: String?) {
                    exits += tabId
                }
            },
            { c.transport }, { Env.tmuxSocket }, { c.appId },
        )
        fun bytes(id: String) = synchronized(out) { out[id]?.toByteArray() ?: ByteArray(0) }
        fun text(id: String) = bytes(id).toString(Charsets.UTF_8)

        tm.open("t1", TermSpec.Tmux(session), 100, 30)
        waitFor("claude output") { text("t1").contains("fake claude") }
        tm.ack("t1", bytes("t1").size)
        fun clients() = tmux("list-clients", "-t", "=$session", "-F", "#{client_pid} #{client_width}x#{client_height}")
        waitFor("client size", 5000) { clients().contains("100x30") }
        // the agent tells apps apart by the CLAUDESPACE_APP of the tmux client (agent/cclib/route.py)
        val pid = clients().trim().lines().single().substringBefore(' ')
        val environ = File("/proc/$pid/environ").readText().split('\u0000')
        assertTrue("CLAUDESPACE_APP=${c.appId}" in environ, environ.filter { it.startsWith("CLAUDESPACE") }.toString())
        tm.resize("t1", 120, 40)
        waitFor("resized", 5000) { clients().contains("120x40") }
        // Ctrl+B d: the channel ends, the session stays
        tm.write("t1", "\u0002d".toByteArray())
        waitFor("detach", 5000) { "t1" in exits }
        assertTrue(tmux("list-sessions", "-F", "#{session_name}").lines().contains(session))

        // flow control: without acks the channel pauses near HIGH_WATER
        tm.open("t2", TermSpec.Shell("~"), 80, 24)
        Thread.sleep(500)
        tm.write("t2", "yes 0123456789012345678901234567890123456789 | head -c 30000000; echo; echo DONE-MARK\n".toByteArray())
        waitFor("paused") { tm.stats("t2")?.paused == true }
        Thread.sleep(500)
        assertTrue(bytes("t2").size < HIGH_WATER * 4, "got ${bytes("t2").size}")
        var acked = 0
        waitFor("stream finished", 60_000) {
            val total = bytes("t2").size
            if (total > acked) {
                tm.ack("t2", total - acked)
                acked = total
            }
            text("t2").takeLast(4000).contains("DONE-MARK")
        }
        tm.close("t2")
        c.callBlocking("kill_session", mapOf("session" to JsonPrimitive(session)))
        tm.shutdown()
        c.shutdown()
    }

    @Test
    @Order(6)
    fun `network drop - goes offline and reconnects by itself with fresh snapshots`() {
        val (c, rec) = conn()
        c.start()
        online(c)
        val app1 = c.appId
        val n0 = rec.events.size
        val s0 = rec.states.size
        server.dropClients()
        val off = waitFor("offline") { rec.firstAfter<ConnState.Offline>(s0) }
        assertEquals(1, off.attempt)
        online(c, "reconnected")
        assertNotEquals(app1, c.appId, "a new connection gets a new app id")
        fullChats(rec, n0)
        // a dropped socket under sshj behaves the same
        val s1 = rec.states.size
        c.debugDrop()
        waitFor("offline 2") { rec.firstAfter<ConnState.Offline>(s1) }
        online(c, "reconnected 2")
        c.shutdown()
    }

    @Test
    @Order(7)
    fun `keepalive - an agent that stops answering is dropped and the connection comes back`() {
        val (c, rec) = conn(keepaliveSec = 1)
        c.start()
        online(c)
        waitFor("rtt") { (c.state as? ConnState.Online)?.rttMs }
        val pid = run("pgrep", "-f", "--", "--app ${c.appId}").trim().lines().single()
        try {
            val s0 = rec.states.size
            run("kill", "-STOP", pid)
            val off = waitFor("offline", 10_000) { rec.firstAfter<ConnState.Offline>(s0) }
            assertEquals("нет ответа (keepalive)", off.error)
            online(c, "reconnected")
        } finally {
            run("kill", "-CONT", pid)
            run("kill", "-KILL", pid)
            c.shutdown()
        }
    }

    @Test
    @Order(8)
    fun `stop during the backoff - idle, no more attempts`() {
        val rec = Recorder()
        val c = Connection(
            { ConnectionConfig("127.0.0.1", 1, "tester", key) }, Env.bundle, File(dir, "known_hosts"), rec,
        )
        c.start()
        val off = waitFor("offline") { rec.firstAfter<ConnState.Offline>() }
        assertTrue(off.error.startsWith("VM недоступна"), off.error)
        assertTrue(off.retryAt > System.currentTimeMillis() - 1000)
        c.stop()
        val n = rec.states.size
        Thread.sleep(1500)
        assertEquals(n, rec.states.size)
        assertEquals(ConnState.Idle, c.state)
        c.shutdown()
    }
}

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class SshFailuresTest {
    private lateinit var fh: FakeHome
    private lateinit var dir: File
    private val key = SshKey.generate("phone-test")

    @BeforeAll
    fun setup() {
        fh = FakeHome.create()
        dir = Files.createTempDirectory("cs-kt-").toFile()
    }

    @AfterAll
    fun cleanup() {
        killTmux()
        fh.close()
        dir.deleteRecursively()
    }

    private fun conn(port: Int, k: SshKey = key, cfg: ConnectionConfig? = ConnectionConfig("127.0.0.1", port, "tester", k, 15, Env.tmuxSocket)): Pair<Connection, Recorder> {
        val rec = Recorder()
        return Connection({ cfg }, Env.bundle, File(dir, "known_hosts"), rec) to rec
    }

    @Test
    fun `refuses a changed host key and never adds it`() {
        val first = TestSshd(fh.home, key.publicOpenSsh)
        val port = first.port
        val (a, ra) = conn(port)
        a.start()
        waitFor("new key", 15_000) { ra.firstAfter<ConnState.NeedsUser>() }
        a.trustHost(true)
        waitFor("online", 20_000) { a.state is ConnState.Online }
        a.shutdown()
        first.close()

        val second = TestSshd(fh.home, key.publicOpenSsh, port = port)
        try {
            val (b, rb) = conn(port)
            b.start()
            val st = waitFor("mismatch", 15_000) { rb.firstAfter<ConnState.NeedsUser>() }
            assertEquals(ConnState.Reason.HOSTKEY_MISMATCH, st.reason)
            val s0 = rb.states.size
            b.trustHost(true)
            waitFor("asks again", 15_000) { rb.firstAfter<ConnState.NeedsUser>(s0) }
            assertEquals(1, File(dir, "known_hosts").readLines().count { it.contains("]:$port ") })
            b.shutdown()
        } finally {
            second.close()
        }
    }

    @Test
    fun `a key the VM does not know - auth-rejected with its fingerprint`() {
        TestSshd(fh.home, key.publicOpenSsh).use { srv ->
            KnownHosts.forget(File(dir, "known_hosts"), "127.0.0.1", srv.port)
            val wrong = SshKey.generate("other")
            val (c, rec) = conn(srv.port, wrong)
            c.start()
            waitFor("host key", 15_000) { rec.firstAfter<ConnState.NeedsUser>() }
            val s0 = rec.states.size
            c.trustHost(true)
            val st = waitFor("rejected", 15_000) { rec.firstAfter<ConnState.NeedsUser>(s0) }
            assertEquals(ConnState.Reason.AUTH_REJECTED, st.reason)
            assertEquals(wrong.fingerprint, st.detail)
            c.shutdown()
        }
    }

    @Test
    fun `no settings - needs-user config`() {
        val (c, rec) = conn(0, cfg = null)
        c.start()
        val st = waitFor("config", 5000) { rec.firstAfter<ConnState.NeedsUser>() }
        assertEquals(ConnState.Reason.CONFIG, st.reason)
        c.shutdown()
    }

    @Test
    fun `no tmux on the VM - needs-user agent-missing-deps`() {
        val bin = File(dir, "bin").apply { mkdirs() }
        for (tool in listOf("python3", "cat")) {
            Files.createSymbolicLink(File(bin, tool).toPath(), File(run("bash", "-c", "command -v $tool").trim()).toPath())
        }
        TestSshd(fh.home, key.publicOpenSsh, path = bin.path).use { srv ->
            val (c, rec) = conn(srv.port)
            c.start()
            waitFor("host key", 15_000) { rec.firstAfter<ConnState.NeedsUser>() }
            val s0 = rec.states.size
            c.trustHost(true)
            val st = waitFor("missing tmux", 15_000) { rec.firstAfter<ConnState.NeedsUser>(s0) }
            assertEquals(ConnState.Reason.AGENT_MISSING_DEPS, st.reason)
            assertEquals("На VM нет tmux", st.detail)
            c.shutdown()
        }
    }
}
