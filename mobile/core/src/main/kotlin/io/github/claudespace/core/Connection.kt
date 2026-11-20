package io.github.claudespace.core

import java.io.File
import java.io.IOException
import kotlin.concurrent.thread
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

// The single connection to the VM (a port of src/main/connection.ts): SSH with the app's key -> host key (TOFU) ->
// agent install -> agent channel -> online, keepalive with RTT, reconnect with backoff 1/2/4/8/16/30 s ±20 %.

data class ConnectionConfig(
    val host: String,
    val port: Int = 22,
    val user: String,
    val key: SshKey,
    val keepaliveSec: Int = 15,
    /** a separate tmux server (`tmux -L`), for tests */
    val tmuxSocket: String? = null,
)

/**
 * What the connection reports. Called under the connection's lock and, for events, on the agent channel's reader
 * thread: hand the work off, don't block.
 */
interface ConnectionListener {
    fun state(s: ConnState) {}
    /** agent events in order, `hello` first after each (re)connect */
    fun event(name: String, data: JsonElement) {}
    /** online again; downMs: how long the connection was down (0 on the first connect) */
    fun online(downMs: Long) {}
    /** an online connection was lost (its terminals are gone) */
    fun offline() {}
    fun log(line: String) {}
}

private val BACKOFF = longArrayOf(1, 2, 4, 8, 16, 30)

fun backoffDelay(attempt: Int, rand: () -> Double = Math::random): Long =
    Math.round(BACKOFF[minOf(attempt, BACKOFF.size - 1)] * 1000 * (0.8 + 0.4 * rand()))

/** Opens the SSH transport; tests swap it. */
fun interface SshConnector {
    fun connect(target: SshTarget, key: SshKey, hostKey: HostKeyCheck, knownTypes: List<String>): Transport
}

class Connection(
    private val config: () -> ConnectionConfig?,
    private val bundle: AgentBundle,
    private val knownHostsFile: File,
    private val listener: ConnectionListener,
    private val helloTimeoutMs: Long = 10_000,
    private val connector: SshConnector = SshConnector { t, k, h, types -> SshTransport.connect(t, k, h, types) },
) {
    private class PendingKey(val host: String, val port: Int, val blob: ByteArray, val result: HostKeyResult)
    private class NeedsUserException(val state: ConnState.NeedsUser) : Exception(state.reason.wire)
    private sealed class Outcome {
        class Lost(val why: String) : Outcome()
        class Failed(val why: String) : Outcome()
        class Needs(val state: ConnState.NeedsUser) : Outcome()
    }

    private val lock = Any()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var gen = 0
    private var job: Job? = null
    private var rpc: AgentRpc? = null
    @Volatile private var pendingHostKey: PendingKey? = null

    @Volatile var state: ConnState = ConnState.Idle
        private set
    @Volatile var transport: Transport? = null
        private set
    @Volatile var hello: JsonObject? = null
        private set
    /**
     * This app on the VM for the current connection: the agent's --app and CLAUDESPACE_APP in our terminals, so that
     * with several apps (PC, phone) a sudo prompt or a link comes to the app whose terminal it came from.
     */
    @Volatile var appId: String? = null
        private set

    val online: Boolean
        get() = state is ConnState.Online && rpc?.isClosed == false

    private fun log(s: String) = listener.log("[conn] $s")

    fun start() {
        synchronized(lock) {
            if (job?.isActive == true) {
                if (state !is ConnState.Online) wake.trySend(Unit)
                return
            }
            val g = ++gen
            job = scope.launch { loop(g) }
        }
    }

    /** retry now instead of waiting for the backoff, or after the user has fixed what needs-user asked for */
    fun retryNow() = start()

    /** Disconnect and stay idle. Does not block: the channels and the socket close in the background. */
    fun stop() {
        val (r, t) = synchronized(lock) {
            gen++
            job?.cancel()
            job = null
            val old = rpc to transport
            rpc = null
            transport = null
            hello = null
            setState(gen, ConnState.Idle)
            old
        }
        if (r != null || t != null) {
            thread(name = "cs-conn-close", isDaemon = true) {
                runCatching { r?.close() }
                runCatching { t?.close() }
            }
        }
    }

    /** stop for good (the service is destroyed) */
    fun shutdown() {
        stop()
        scope.cancel()
    }

    /** The user's answer to hostkey-new. A changed key (hostkey-mismatch) is never added here. */
    fun trustHost(accept: Boolean) {
        val pk = pendingHostKey
        if (accept && pk != null && pk.result == HostKeyResult.UNKNOWN) {
            KnownHosts.trust(knownHostsFile, pk.host, pk.port, pk.blob)
            log("trusted host key ${pk.host} ${fingerprintOf(pk.blob)}")
        }
        pendingHostKey = null
        if (accept) retryNow()
    }

    suspend fun call(method: String, params: JsonElement = JsonObject(emptyMap()), timeoutMs: Long = 10_000): JsonElement {
        val r = rpc
        if (r == null || r.isClosed || state !is ConnState.Online) throw RpcException("offline", "нет связи с VM")
        return r.call(method, params, timeoutMs)
    }

    /** drop the connection as a network loss would (tests, debugging) */
    fun debugDrop() {
        log("debug: drop connection")
        transport?.drop()
    }

    private fun setState(g: Int, s: ConnState) {
        synchronized(lock) {
            if (g != gen) return
            state = s
            listener.state(s)
        }
    }

    private fun adopt(g: Int, t: Transport? = null, r: AgentRpc? = null): Boolean = synchronized(lock) {
        if (g != gen) return false
        if (t != null) transport = t
        if (r != null) rpc = r
        true
    }

    private fun teardown(g: Int) {
        val (r, t) = synchronized(lock) {
            if (g != gen) return
            val old = rpc to transport
            rpc = null
            transport = null
            hello = null
            old
        }
        runCatching { r?.close() }
        runCatching { t?.close() }
    }

    private suspend fun loop(g: Int) {
        var attempt = 0
        var lostSince: Long? = null
        while (true) {
            wake.tryReceive() // a retry asked for before this attempt
            val outcome = try {
                runSession(g, attempt, lostSince)
            } catch (e: CancellationException) {
                teardown(g)
                throw e
            } catch (e: NeedsUserException) {
                Outcome.Needs(e.state)
            } catch (e: InstallException) {
                if (e.needsUser) {
                    Outcome.Needs(ConnState.NeedsUser(ConnState.Reason.AGENT_MISSING_DEPS, detail = e.message))
                } else {
                    Outcome.Failed(e.message ?: "install")
                }
            } catch (e: Exception) {
                Outcome.Failed(e.message ?: e.toString())
            }
            teardown(g)
            when (outcome) {
                is Outcome.Needs -> {
                    log("needs user: ${outcome.state.reason.wire} ${outcome.state.detail ?: ""}")
                    setState(g, outcome.state)
                    wake.receive()
                    continue
                }
                is Outcome.Lost -> {
                    log("lost: ${outcome.why}")
                    attempt = 0
                    lostSince = System.currentTimeMillis()
                    listener.offline()
                }
                is Outcome.Failed -> log("failed: ${outcome.why}")
            }
            val why = when (outcome) {
                is Outcome.Lost -> outcome.why
                is Outcome.Failed -> outcome.why
                is Outcome.Needs -> ""
            }
            val delayMs = backoffDelay(attempt)
            attempt++
            val now = System.currentTimeMillis()
            val since = lostSince ?: now.also { lostSince = it }
            setState(g, ConnState.Offline(since, now + delayMs, attempt, why))
            withTimeoutOrNull(delayMs) { wake.receive() }
        }
    }

    /** One connection: returns when an online connection is lost, throws if it never got online. */
    private suspend fun runSession(g: Int, attempt: Int, lostSince: Long?): Outcome.Lost {
        setState(g, ConnState.Connecting(ConnState.Step.CONFIG, attempt))
        val cfg = config()
        if (cfg == null || cfg.host.isBlank() || cfg.user.isBlank()) {
            throw NeedsUserException(
                ConnState.NeedsUser(ConnState.Reason.CONFIG, detail = "Укажите адрес VM и пользователя"),
            )
        }
        setState(g, ConnState.Connecting(ConnState.Step.AUTH, attempt))
        pendingHostKey = null
        val target = SshTarget(cfg.host, cfg.port, cfg.user)
        val check = HostKeyCheck { host, port, blob ->
            setState(g, ConnState.Connecting(ConnState.Step.HOSTKEY, attempt))
            when (val res = KnownHosts.check(KnownHosts.read(knownHostsFile), host, port, blob)) {
                HostKeyResult.MATCH -> true
                else -> {
                    pendingHostKey = PendingKey(host, port, blob, res)
                    false
                }
            }
        }
        val knownTypes = KnownHosts.knownTypes(KnownHosts.read(knownHostsFile), cfg.host, cfg.port)
        // not cancellable: a transport that connects after stop() must still be closed, not leaked
        val t = try {
            withContext(NonCancellable) { connector.connect(target, cfg.key, check, knownTypes) }
        } catch (e: SshConnectException) {
            val pk = pendingHostKey
            if (pk != null) {
                throw NeedsUserException(
                    ConnState.NeedsUser(
                        if (pk.result == HostKeyResult.MISMATCH) ConnState.Reason.HOSTKEY_MISMATCH
                        else ConnState.Reason.HOSTKEY_NEW,
                        fingerprint = fingerprintOf(pk.blob),
                        host = if (pk.port == 22) pk.host else "${pk.host}:${pk.port}",
                    ),
                )
            }
            if (e.kind == SshFailure.AUTH_REJECTED) {
                throw NeedsUserException(ConnState.NeedsUser(ConnState.Reason.AUTH_REJECTED, detail = cfg.key.fingerprint))
            }
            throw IOException("VM недоступна: ${e.message}", e)
        }
        if (!adopt(g, t = t)) {
            t.close()
            throw CancellationException("stopped")
        }
        val lost = CompletableDeferred<String>()
        t.onClose { lost.complete(it.ifBlank { "соединение закрыто" }) }

        setState(g, ConnState.Connecting(ConnState.Step.AGENT, attempt))
        val ens = ensureAgent(t, bundle) { msg -> setState(g, ConnState.Connecting(ConnState.Step.AGENT, attempt, msg)) }
        if (ens.installed) log("agent installed")
        if (ens.kept != null) log("the agent on the VM is from a newer release (${ens.kept}), keeping it")

        val id = newAppId()
        appId = id
        val ch = t.exec(agentCommand(cfg.tmuxSocket, id))
        // events that arrive right after hello (the first snapshots) are held until we are online
        val early = mutableListOf<Pair<String, JsonElement>>()
        var live = false
        val helloD = CompletableDeferred<JsonObject>()
        val holder = arrayOfNulls<AgentRpc>(1)
        val r = AgentRpc(ch, object : RpcListener {
            override fun event(name: String, data: JsonElement) {
                if (name == "hello") {
                    helloD.complete(data as? JsonObject ?: JsonObject(emptyMap()))
                    return
                }
                synchronized(early) {
                    if (!live) {
                        early += name to data
                        return
                    }
                }
                if (rpc === holder[0]) listener.event(name, data)
            }

            override fun log(line: String) = listener.log("[agent] ${line.trimEnd()}")

            override fun closed(code: Int?) {
                helloD.completeExceptionally(IOException("агент завершился при запуске"))
                lost.complete("агент завершился")
            }
        })
        holder[0] = r
        if (!adopt(g, r = r)) {
            r.close()
            throw CancellationException("stopped")
        }
        r.start()
        val hello = withTimeoutOrNull(helloTimeoutMs) { helloD.await() }
            ?: throw IOException("Агент не ответил за ${helloTimeoutMs / 1000} с")
        val protocol = hello["protocol"]?.jsonPrimitive?.intOrNull
        if (protocol != PROTOCOL) throw IOException("агент говорит на протоколе $protocol, нужен $PROTOCOL")
        this.hello = hello
        val str = { k: String -> hello[k]?.jsonPrimitive?.contentOrNull ?: "" }
        setState(g, ConnState.Online(System.currentTimeMillis(), null, str("agent"), "${str("user")}@${str("host")}"))
        synchronized(early) {
            listener.event("hello", hello)
            for ((n, d) in early) listener.event(n, d)
            live = true
        }
        listener.online(lostSince?.let { System.currentTimeMillis() - it } ?: 0)
        log("online ${str("host")} agent ${str("agent")} app $id")

        return coroutineScope {
            val pinger = launch { ping(g, r, cfg.keepaliveSec, lost) }
            val why = lost.await()
            pinger.cancel()
            Outcome.Lost(why)
        }
    }

    private suspend fun ping(g: Int, r: AgentRpc, sec: Int, lost: CompletableDeferred<String>) {
        while (true) {
            val t0 = System.currentTimeMillis()
            try {
                r.call("ping", JsonObject(emptyMap()), sec * 3000L)
                synchronized(lock) {
                    val s = state
                    if (g == gen && s is ConnState.Online && !lost.isCompleted) {
                        setState(g, s.copy(rttMs = System.currentTimeMillis() - t0))
                    }
                }
            } catch (e: RpcException) {
                if (e.code == "timeout") {
                    log("ping timeout")
                    // the reason first: dropping the socket makes sshj report its own ("Socket closed")
                    lost.complete("нет ответа (keepalive)")
                    transport?.drop()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // never end an online session from here: losing it is the transport's and the agent's call
                log("ping: $e")
            }
            delay(sec * 1000L)
        }
    }
}
