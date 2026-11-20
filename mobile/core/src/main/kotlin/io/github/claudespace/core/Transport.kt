package io.github.claudespace.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayOutputStream

// What the agent installer, the RPC and the terminals see of an SSH connection: commands (optionally on a PTY) and
// file uploads. SshTransport is the real one (sshj); tests can put a fake behind the same interface.

data class Pty(val cols: Int, val rows: Int, val term: String = "xterm-256color")

/** Output of one channel. Called on the channel's reader threads: return quickly. */
interface ChannelListener {
    fun data(b: ByteArray) {}
    fun stderr(b: ByteArray) {}
    /** once, after both streams ended: exit code and signal name if the remote side sent them */
    fun closed(code: Int?, signal: String?) {}
}

/** One exec channel: a remote command with stdin/stdout/stderr, optionally on a PTY. */
interface ExecChannel {
    /** Starts reading. Output that arrived before stays buffered by SSH, nothing is lost. */
    fun start(listener: ChannelListener)
    fun write(data: ByteArray)
    /** close stdin (EOF) */
    fun end()
    /** close the channel (the remote process gets SIGHUP) */
    fun close()
    fun setWindow(cols: Int, rows: Int)
    /** stop reading: the SSH window fills up and the remote side waits (terminal flow control) */
    fun pause()
    fun resume()
}

interface Transport {
    /** run `cmd` through the user's shell on the target */
    fun exec(cmd: String, pty: Pty? = null): ExecChannel
    /** write a file over SFTP; relative paths are relative to the remote home */
    fun writeFile(path: String, data: ByteArray, mode: Int)
    /** called once when the connection ends, for any reason */
    fun onClose(cb: (String) -> Unit)
    val isOpen: Boolean
    fun close()
    /** drop the connection abruptly (keepalive timeout; tests) */
    fun drop()
}

data class ExecResult(val code: Int?, val stdout: String, val stderr: String)

/** Run a command, collect its output, return when it ends. */
suspend fun execCollect(t: Transport, cmd: String, timeoutMs: Long = 15_000): ExecResult {
    val ch = withContext(Dispatchers.IO) { t.exec(cmd) }
    val out = ByteArrayOutputStream()
    val err = ByteArrayOutputStream()
    val done = CompletableDeferred<Int?>()
    ch.start(object : ChannelListener {
        override fun data(b: ByteArray) = synchronized(out) { out.write(b) }
        override fun stderr(b: ByteArray) = synchronized(err) { err.write(b) }
        override fun closed(code: Int?, signal: String?) {
            done.complete(code)
        }
    })
    withContext(Dispatchers.IO) { ch.end() }
    val code = withTimeoutOrNull(timeoutMs) { done.await() }
    if (!done.isCompleted) {
        withContext(Dispatchers.IO) { ch.close() }
        throw java.io.IOException("timeout: ${cmd.take(60)}")
    }
    return ExecResult(code, synchronized(out) { out.toString(Charsets.UTF_8) }, synchronized(err) { err.toString(Charsets.UTF_8) })
}
