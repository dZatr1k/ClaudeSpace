package io.github.claudespace.core

import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

// Terminal channels: exec with a PTY on the current transport (a port of src/main/terminals.ts). tmux tabs attach to a
// session; the other kinds run shell/lazygit/yazi/git clone directly. Output is batched (8 ms) and flow-controlled by
// acks from the UI: past HIGH_WATER unacknowledged bytes the channel stops reading until the UI catches up.

const val BATCH_MS = 8L
const val HIGH_WATER = 1024 * 1024
const val LOW_WATER = 256 * 1024

/** What a terminal tab runs (TermOpenArgs in src/shared/ipc.ts). */
sealed class TermSpec {
    data class Tmux(val session: String) : TermSpec()
    data class Shell(val cwd: String = "~") : TermSpec()
    data class Lazygit(val cwd: String = "~") : TermSpec()
    data class Yazi(val cwd: String = "~") : TermSpec()
    data class Clone(val url: String, val dest: String) : TermSpec()
}

private const val BASE_PREFIX =
    "export LANG=\"\${LANG:-C.UTF-8}\"; export PATH=\"\$HOME/.local/bin:\$PATH\"; unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT;"

private val REPO_URL_RE = Regex("^(https?://|git@|ssh://|git://)\\S+$")

private fun homePath(p: String): String = when {
    p == "~" -> "\"\$HOME\""
    p.startsWith("~/") -> "\"\$HOME\"/" + shq(p.substring(2))
    else -> shq(p)
}

/**
 * Shell command for a terminal (runs through the user's shell on the VM). Throws on bad input. appId: this
 * connection's id, exported as CLAUDESPACE_APP so that the agent knows which app a tmux client or a shell belongs to
 * (agent/cclib/route.py).
 */
fun terminalCommand(spec: TermSpec, tmuxSocket: String? = null, appId: String? = null): String {
    val tmux = if (tmuxSocket != null) "tmux -L ${shq(tmuxSocket)}" else "tmux"
    val prefix = BASE_PREFIX + if (appId != null && APP_ID_RE.matches(appId)) " export CLAUDESPACE_APP=$appId;" else ""
    return when (spec) {
        is TermSpec.Tmux -> {
            require(SESSION_RE.matches(spec.session)) { "bad session name" }
            "$prefix exec $tmux -u attach-session -t ${shq("=" + spec.session)}"
        }
        is TermSpec.Shell -> "$prefix cd ${homePath(spec.cwd)} && exec bash -l"
        is TermSpec.Lazygit -> "$prefix cd ${homePath(spec.cwd)} && exec lazygit"
        is TermSpec.Yazi -> "$prefix exec yazi ${homePath(spec.cwd)}"
        is TermSpec.Clone -> {
            require(spec.url.isNotEmpty() && spec.dest.isNotEmpty()) { "url and dest required" }
            require(REPO_URL_RE.matches(spec.url)) { "bad repository url" }
            "$prefix cd \"\$HOME\" && git clone -- ${shq(spec.url)} ${homePath(spec.dest)}"
        }
    }
}

/** Where terminal output goes (the UI). Called from the core's batching thread. */
interface TerminalSink {
    fun data(tabId: String, data: ByteArray)
    fun exit(tabId: String, code: Int?, signal: String?)
}

class TerminalManager(
    private val sink: TerminalSink,
    private val transport: () -> Transport?,
    private val tmuxSocket: () -> String? = { null },
    private val appId: () -> String? = { null },
) {
    private class Term(val ch: ExecChannel) {
        val pending = ByteArrayOutputStream()
        var timer: ScheduledFuture<*>? = null
        var unacked = 0L
        var paused = false
    }

    private val terms = ConcurrentHashMap<String, Term>()
    private val timer = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "cs-term-flush").apply { isDaemon = true }
    }

    fun has(tabId: String): Boolean = terms.containsKey(tabId)

    /** Opens a terminal for the tab (closing the tab's previous one). Blocking: call off the main thread. */
    fun open(tabId: String, spec: TermSpec, cols: Int, rows: Int) {
        val t = transport() ?: throw java.io.IOException("нет связи с VM")
        close(tabId)
        val ch = t.exec(terminalCommand(spec, tmuxSocket(), appId()), Pty(cols, rows))
        val term = Term(ch)
        terms[tabId] = term
        ch.start(object : ChannelListener {
            override fun data(b: ByteArray) = onData(tabId, term, b)
            override fun stderr(b: ByteArray) = onData(tabId, term, b)
            override fun closed(code: Int?, signal: String?) {
                timer.execute {
                    flush(tabId, term)
                    if (terms.remove(tabId, term)) sink.exit(tabId, code, signal)
                }
            }
        })
    }

    private fun onData(tabId: String, term: Term, b: ByteArray) {
        synchronized(term) {
            term.pending.write(b)
            term.unacked += b.size
            if (!term.paused && term.unacked > HIGH_WATER) {
                term.paused = true
                term.ch.pause()
            }
            if (term.timer == null) term.timer = timer.schedule({ flush(tabId, term) }, BATCH_MS, TimeUnit.MILLISECONDS)
        }
    }

    private fun flush(tabId: String, term: Term) {
        val data = synchronized(term) {
            term.timer?.cancel(false)
            term.timer = null
            if (term.pending.size() == 0) return
            term.pending.toByteArray().also { term.pending.reset() }
        }
        if (terms[tabId] === term) sink.data(tabId, data)
    }

    /** the UI has written `bytes` of this tab's output to the screen */
    fun ack(tabId: String, bytes: Int) {
        val term = terms[tabId] ?: return
        synchronized(term) {
            term.unacked = maxOf(0, term.unacked - bytes)
            if (term.paused && term.unacked < LOW_WATER) {
                term.paused = false
                term.ch.resume()
            }
        }
    }

    fun write(tabId: String, data: ByteArray) {
        terms[tabId]?.ch?.write(data)
    }

    fun resize(tabId: String, cols: Int, rows: Int) {
        terms[tabId]?.ch?.setWindow(cols, rows)
    }

    fun close(tabId: String) {
        val term = terms.remove(tabId) ?: return
        synchronized(term) { term.timer?.cancel(false) }
        term.ch.close()
    }

    /** the connection is gone and its channels with it: forget them without exit callbacks */
    fun dropAll() {
        for (term in terms.values) synchronized(term) { term.timer?.cancel(false) }
        terms.clear()
    }

    data class Stats(val unacked: Long, val paused: Boolean)

    fun stats(tabId: String): Stats? = terms[tabId]?.let { synchronized(it) { Stats(it.unacked, it.paused) } }

    fun shutdown() {
        terms.keys.toList().forEach { close(it) }
        timer.shutdownNow()
    }
}
