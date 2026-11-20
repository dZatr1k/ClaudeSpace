package io.github.claudespace.core

import java.io.File
import kotlin.io.encoding.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

// The phone's core behind the bridge (src/shared/mobile.ts): the same channels the browser dev core answers
// (src/main/mobileDev.ts), over Connection, TerminalManager and the attachment upload. The Android service hosts it and
// adds what needs Android (notifications, the Keystore, the plugin); everything here runs and is tested on the JVM.

/** What the core reports. Called on connection and channel threads: hand the work off, don't block. */
interface PhoneEvents {
    /** an event for the UI (the bridge's `on`): conn.state, agent.event, term.data, term.exit, settings.changed */
    fun event(name: String, data: JsonElement) {}
    /** the connection state, for the service's own notification */
    fun state(s: ConnState) {}
    /** a Claude turn ended, for notifications */
    fun turn(t: TurnDone) {}
    /** settings changed (the background switch) */
    fun settings(s: PhoneSettings) {}
    fun log(line: String) {}
}

/** methods only the desktop main may call (MAIN_ONLY_METHODS in src/shared/protocol.ts) */
private val MAIN_ONLY = setOf(
    "winfs_status", "winfs_mount", "winfs_unmount", "pc_tunnel_status", "askpass_enable", "askpass_reply",
    "fs_upload_target", "fs_download_source",
)
private val METHOD_RE = Regex("^[a-z_]{1,40}$")
private val TAB_RE = Regex("^[A-Za-z0-9_-]{1,64}$")

/** list events a UI needs to fill its lists when it opens on a running core (events.replay) */
private val REPLAYED = listOf("hello", "active_changed", "projects_changed", "system", "doctor_warning", "ports_changed")

/** methodTimeout in src/shared/protocol.ts */
fun methodTimeout(m: String): Long = when (m) {
    "doctor", "usage" -> 60_000
    "list_projects", "project_preview", "create_project", "system", "worktree_create", "usage_report",
    "worktree_remove" -> 30_000
    else -> 10_000
}

class PhoneCore(
    private val dataDir: File,
    private val bundle: AgentBundle,
    private val vault: KeyVault,
    private val tmuxSocket: String? = null,
    private val keepaliveSec: Int = 15,
    connector: SshConnector = SshConnector { t, k, h, types -> SshTransport.connect(t, k, h, types) },
) {
    @Volatile var events: PhoneEvents? = null
    @Volatile var settings: PhoneSettings = PhoneSettings.load(File(dataDir, "settings.json"))
        private set
    val key: SshKey by lazy { vault.loadOrCreate() }
    private val knownHosts = File(dataDir, "known_hosts")
    private val latest = LinkedHashMap<String, JsonElement>()
    private val chats = LinkedHashMap<String, JsonElement>()

    val connection: Connection = Connection(
        config = {
            val s = settings
            if (s.configured) ConnectionConfig(s.host, s.port, s.user, key, keepaliveSec, tmuxSocket) else null
        },
        bundle = bundle,
        knownHostsFile = knownHosts,
        listener = object : ConnectionListener {
            override fun state(s: ConnState) = pushState()
            override fun event(name: String, data: JsonElement) = onAgentEvent(name, data)
            override fun offline() = terminals.dropAll()
            override fun log(line: String) {
                events?.log(line)
            }
        },
        connector = connector,
    )

    val terminals: TerminalManager = TerminalManager(
        sink = object : TerminalSink {
            override fun data(tabId: String, data: ByteArray) {
                events?.event("term.data", buildJsonObject {
                    put("tabId", JsonPrimitive(tabId))
                    put("data64", JsonPrimitive(Base64.encode(data)))
                })
            }

            override fun exit(tabId: String, code: Int?, signal: String?) {
                events?.event("term.exit", buildJsonObject {
                    put("tabId", JsonPrimitive(tabId))
                    put("code", code?.let { JsonPrimitive(it) } ?: JsonNull)
                    put("signal", signal?.let { JsonPrimitive(it) } ?: JsonNull)
                })
            }
        },
        transport = { connection.transport },
        tmuxSocket = { tmuxSocket },
        appId = { connection.appId },
    )

    /** what the UI shows: like the browser dev core, nothing starts until a host and a user are set */
    fun state(): ConnState =
        if (!settings.configured) ConnState.NeedsUser(ConnState.Reason.CONFIG, detail = "Укажите адрес VM и пользователя")
        else connection.state

    private fun pushState() {
        val s = state()
        events?.event("conn.state", s.toJson())
        events?.state(s)
    }

    fun start() {
        if (settings.configured) connection.start() else pushState()
    }

    fun shutdown() {
        terminals.shutdown()
        connection.shutdown()
    }

    /** the project folder of a chat, from the latest chat list (a notification is named after it) */
    fun chatProject(chatId: String?): String? {
        if (chatId == null) return null
        val c = synchronized(latest) { chats[chatId] } as? JsonObject ?: return null
        return (c["project"] as? JsonPrimitive)?.contentOrNull
    }

    private fun onAgentEvent(name: String, data: JsonElement) {
        remember(name, data)
        events?.event("agent.event", buildJsonObject {
            put("event", JsonPrimitive(name))
            put("data", data)
        })
        if (name == "turn_done") TurnDone.parse(data)?.let { events?.turn(it) }
    }

    private fun remember(name: String, data: JsonElement) {
        synchronized(latest) {
            if (name == "chats_changed") {
                val d = data as? JsonObject ?: return
                (d["full"] as? JsonArray)?.let { full ->
                    chats.clear()
                    for (c in full) idOf(c)?.let { chats[it] = c }
                }
                (d["upsert"] as? JsonArray)?.forEach { c -> idOf(c)?.let { chats[it] = c } }
                (d["remove"] as? JsonArray)?.forEach { (it as? JsonPrimitive)?.contentOrNull?.let(chats::remove) }
            } else if (name in REPLAYED) {
                latest[name] = data
            }
        }
    }

    private fun idOf(c: JsonElement) = ((c as? JsonObject)?.get("id") as? JsonPrimitive)?.contentOrNull

    private fun replay(): JsonArray {
        if (connection.state !is ConnState.Online) return JsonArray(emptyList())
        return synchronized(latest) {
            buildJsonArray {
                fun add(name: String, data: JsonElement) = add(buildJsonObject {
                    put("event", JsonPrimitive(name))
                    put("data", data)
                })
                latest["hello"]?.let { add("hello", it) }
                for ((name, data) in latest) if (name != "hello") add(name, data)
                add("chats_changed", buildJsonObject { put("full", JsonArray(chats.values.toList())) })
            }
        }
    }

    /** One bridge call. Throws for an unknown channel or bad arguments (the plugin rejects the call). */
    suspend fun invoke(channel: String, args: JsonElement): JsonElement {
        val a = args as? JsonObject ?: JsonObject(emptyMap())
        fun str(k: String) = (a[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        fun int(k: String) = (a[k] as? JsonPrimitive)?.intOrNull
        return when (channel) {
            "agent.call" -> callAgent(str("method"), a["params"])
            "conn.state" -> state().toJson()
            "conn.retryNow" -> {
                if (settings.configured) connection.retryNow()
                JsonNull
            }
            "conn.trustHost" -> {
                connection.trustHost((a["accept"] as? JsonPrimitive)?.contentOrNull == "true")
                JsonNull
            }
            "conn.forgetHost" -> {
                KnownHosts.forget(knownHosts, settings.host, settings.port)
                JsonNull
            }
            "settings.get" -> settings.toJson()
            "settings.set" -> setSettings(a)
            "key.get" -> buildJsonObject {
                put("publicKey", JsonPrimitive(key.publicOpenSsh))
                put("fingerprint", JsonPrimitive(key.fingerprint))
            }
            "events.replay" -> replay()
            "term.open" -> openTerminal(a)
            "term.write" -> {
                val tabId = str("tabId") ?: throw IllegalArgumentException("tabId")
                val data = str("data") ?: ""
                val binary = (a["binary"] as? JsonPrimitive)?.contentOrNull == "true"
                terminals.write(tabId, data.toByteArray(if (binary) Charsets.ISO_8859_1 else Charsets.UTF_8))
                JsonNull
            }
            "term.resize" -> {
                val cols = int("cols") ?: 0
                val rows = int("rows") ?: 0
                if (cols in 2..1000 && rows in 2..500) terminals.resize(str("tabId") ?: "", cols, rows)
                JsonNull
            }
            "term.close" -> {
                terminals.close(str("tabId") ?: "")
                JsonNull
            }
            "term.ack" -> {
                terminals.ack(str("tabId") ?: "", (a["bytes"] as? JsonPrimitive)?.intOrNull ?: 0)
                JsonNull
            }
            "attach.upload" -> {
                val data = Base64.decode(str("data64") ?: "")
                when (val r = uploadAttachment(connection.transport, str("name") ?: "file", data)) {
                    is UploadResult.Ok -> buildJsonObject {
                        put("ok", JsonPrimitive(true))
                        put("path", JsonPrimitive(r.path))
                    }
                    is UploadResult.Failed -> failed(r.error)
                }
            }
            else -> throw IllegalArgumentException("unknown channel $channel")
        }
    }

    private fun failed(error: String) = buildJsonObject {
        put("ok", JsonPrimitive(false))
        put("error", JsonPrimitive(error))
    }

    private suspend fun callAgent(method: String?, params: JsonElement?): JsonElement {
        if (method == null || !METHOD_RE.matches(method) || method in MAIN_ONLY) {
            return agentError(RpcException("bad_request", "неизвестный метод"))
        }
        val p = params as? JsonObject ?: if (params == null || params is JsonNull) JsonObject(emptyMap()) else
            return agentError(RpcException("bad_request", "неверные параметры"))
        return try {
            val result = connection.call(method, p, methodTimeout(method))
            buildJsonObject {
                put("ok", JsonPrimitive(true))
                put("result", result)
            }
        } catch (e: RpcException) {
            agentError(e)
        }
    }

    private fun agentError(e: RpcException) = buildJsonObject {
        put("ok", JsonPrimitive(false))
        put("error", e.toJson())
    }

    private fun setSettings(patch: JsonObject): JsonElement {
        val before = settings
        val next = before.merge(patch)
        settings = next
        next.save(File(dataDir, "settings.json"))
        events?.event("settings.changed", next.toJson())
        events?.settings(next)
        if (next.host != before.host || next.port != before.port || next.user != before.user) {
            terminals.dropAll()
            connection.stop()
            if (next.configured) connection.start() else pushState()
        }
        return next.toJson()
    }

    private suspend fun openTerminal(a: JsonObject): JsonElement {
        fun str(k: String) = (a[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        val tabId = str("tabId")?.takeIf { TAB_RE.matches(it) } ?: return failed("неверные параметры терминала")
        val cols = (a["cols"] as? JsonPrimitive)?.intOrNull?.takeIf { it in 2..1000 }
        val rows = (a["rows"] as? JsonPrimitive)?.intOrNull?.takeIf { it in 2..500 }
        if (cols == null || rows == null) return failed("неверные параметры терминала")
        return try {
            val spec = when (str("kind")) {
                "tmux" -> TermSpec.Tmux(str("session") ?: "")
                "shell" -> TermSpec.Shell(str("cwd") ?: "~")
                "lazygit" -> TermSpec.Lazygit(str("cwd") ?: "~")
                "yazi" -> TermSpec.Yazi(str("cwd") ?: "~")
                "clone" -> TermSpec.Clone(str("url") ?: "", str("dest") ?: "")
                else -> return failed("неверные параметры терминала")
            }
            withContext(Dispatchers.IO) { terminals.open(tabId, spec, cols, rows) }
            buildJsonObject { put("ok", JsonPrimitive(true)) }
        } catch (e: Exception) {
            failed(e.message ?: e.toString())
        }
    }
}
