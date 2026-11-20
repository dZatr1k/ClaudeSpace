package io.github.claudespace.core

import java.io.IOException
import java.io.InputStream
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.PublicKey
import java.security.Security
import java.util.EnumSet
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.concurrent.thread
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.connection.channel.direct.Session
import net.schmizz.sshj.connection.channel.direct.SessionChannel
import net.schmizz.sshj.sftp.FileAttributes
import net.schmizz.sshj.sftp.OpenMode
import net.schmizz.sshj.sftp.SFTPClient
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.UserAuthException
import org.bouncycastle.jce.provider.BouncyCastleProvider

data class SshTarget(val host: String, val port: Int, val user: String)

/** Decides on the host key; gets its SSH blob. */
fun interface HostKeyCheck {
    fun verify(host: String, port: Int, blob: ByteArray): Boolean
}

enum class SshFailure { AUTH_REJECTED, HOSTKEY, NETWORK, OTHER }

class SshConnectException(val kind: SshFailure, message: String, cause: Throwable? = null) :
    IOException(message, cause)

/** sshj transport: one connection, many channels (agent exec, terminal PTYs, SFTP). Blocking calls. */
class SshTransport private constructor(private val client: SSHClient) : Transport {
    private val closed = AtomicBoolean(false)
    private val closeCbs = mutableListOf<(String) -> Unit>()
    private var closeReason: String? = null
    private var sftp: SFTPClient? = null

    init {
        client.transport.setDisconnectListener { reason, message ->
            fireClose(message?.takeIf { it.isNotBlank() } ?: reason.toString())
        }
    }

    private fun fireClose(why: String) {
        val cbs = synchronized(closeCbs) {
            if (closeReason != null) return
            closeReason = why
            closeCbs.toList()
        }
        closed.set(true)
        cbs.forEach { runCatching { it(why) } }
    }

    override fun onClose(cb: (String) -> Unit) {
        val why = synchronized(closeCbs) {
            closeReason ?: run {
                closeCbs += cb
                return
            }
        }
        cb(why)
    }

    override val isOpen: Boolean
        get() = !closed.get() && client.isConnected

    override fun exec(cmd: String, pty: Pty?): ExecChannel {
        if (!isOpen) throw IOException("нет соединения")
        val session = client.startSession()
        try {
            if (pty != null) session.allocatePTY(pty.term, pty.cols, pty.rows, 0, 0, emptyMap())
            return SshjChannel(session, session.exec(cmd))
        } catch (e: Exception) {
            runCatching { session.close() }
            throw e
        }
    }

    @Synchronized
    private fun sftp(): SFTPClient = sftp ?: client.newSFTPClient().also { sftp = it }

    @Synchronized
    override fun writeFile(path: String, data: ByteArray, mode: Int) {
        val s = sftp()
        val attrs = FileAttributes.Builder().withPermissions(mode).build()
        s.open(path, EnumSet.of(OpenMode.WRITE, OpenMode.CREAT, OpenMode.TRUNC), attrs).use { f ->
            var off = 0
            while (off < data.size) {
                val n = minOf(32 * 1024, data.size - off)
                f.write(off.toLong(), data, off, n)
                off += n
            }
        }
        s.chmod(path, mode)
    }

    override fun close() {
        runCatching { sftp?.close() }
        runCatching { client.disconnect() }
        fireClose("соединение закрыто")
    }

    override fun drop() {
        // closing the socket under sshj: its reader fails and the transport dies, as on a network loss
        runCatching { client.socket?.close() }
    }

    companion object {
        /** BouncyCastle as sshj wants it. On Android it replaces the platform's trimmed "BC" provider. */
        fun installSecurity() {
            synchronized(this) {
                val p = Security.getProvider(BouncyCastleProvider.PROVIDER_NAME)
                if (p is BouncyCastleProvider) return
                if (p != null) Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
                Security.addProvider(BouncyCastleProvider())
            }
        }

        /** Connects, checks the host key, authenticates with the key. Blocking; throws SshConnectException. */
        fun connect(target: SshTarget, key: SshKey, hostKey: HostKeyCheck, knownTypes: List<String> = emptyList(),
            connectTimeoutMs: Int = 15_000): SshTransport {
            installSecurity()
            val client = SSHClient(DefaultConfig())
            client.connectTimeout = connectTimeoutMs
            client.addHostKeyVerifier(object : HostKeyVerifier {
                override fun verify(hostname: String, port: Int, key: PublicKey): Boolean =
                    hostKey.verify(target.host, target.port, Buffer.PlainBuffer().putPublicKey(key).compactData)

                override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = knownTypes
            })
            try {
                client.connect(target.host, target.port)
            } catch (e: Exception) {
                runCatching { client.disconnect() }
                throw SshConnectException(classify(e), e.message ?: e.toString(), e)
            }
            try {
                client.authPublickey(target.user, client.loadKeys(key.privateOpenSsh(), key.publicOpenSsh, null))
            } catch (e: Exception) {
                runCatching { client.disconnect() }
                val kind = if (e is UserAuthException) SshFailure.AUTH_REJECTED else classify(e)
                throw SshConnectException(kind, e.message ?: e.toString(), e)
            }
            return SshTransport(client)
        }

        private fun classify(e: Throwable): SshFailure {
            var c: Throwable? = e
            while (c != null) {
                when (c) {
                    is ConnectException, is NoRouteToHostException, is UnknownHostException,
                    is SocketTimeoutException -> return SshFailure.NETWORK
                }
                if (c.message?.contains("host key", ignoreCase = true) == true) return SshFailure.HOSTKEY
                c = c.cause
            }
            return if (e is IOException) SshFailure.NETWORK else SshFailure.OTHER
        }
    }
}

private val channelSeq = AtomicInteger()

/**
 * A session channel read by two threads (stdout, stderr). pause() parks the stdout reader before its next read:
 * sshj then stops widening the window and the remote side blocks, as ssh2's pause() did on the PC.
 */
internal class SshjChannel(private val session: Session, private val cmd: Session.Command) : ExecChannel {
    private val lock = ReentrantLock()
    private val unpaused = lock.newCondition()
    private var paused = false
    private val started = AtomicBoolean(false)
    private val ended = AtomicInteger(0)
    private val closedFired = AtomicBoolean(false)
    private val writeLock = Any()

    override fun start(listener: ChannelListener) {
        check(started.compareAndSet(false, true)) { "already started" }
        val n = channelSeq.incrementAndGet()
        thread(name = "cs-ch$n-out", isDaemon = true) { pump(cmd.inputStream, listener, listener::data) }
        thread(name = "cs-ch$n-err", isDaemon = true) { pump(cmd.errorStream, listener, listener::stderr) }
    }

    private fun pump(inp: InputStream, l: ChannelListener, cb: (ByteArray) -> Unit) {
        val buf = ByteArray(32 * 1024)
        try {
            while (true) {
                lock.withLock { while (paused) unpaused.await() }
                val n = inp.read(buf)
                if (n < 0) break
                if (n > 0) cb(buf.copyOf(n))
            }
        } catch (_: Exception) {
            // connection gone or channel closed: same as EOF
        }
        if (ended.incrementAndGet() == 2) finish(l)
    }

    private fun finish(l: ChannelListener) {
        if (!closedFired.compareAndSet(false, true)) return
        runCatching { cmd.join(5, TimeUnit.SECONDS) }
        val code = runCatching { cmd.exitStatus }.getOrNull()
        val signal = runCatching { cmd.exitSignal?.name }.getOrNull()
        runCatching { session.close() }
        l.closed(code, signal)
    }

    override fun write(data: ByteArray) {
        synchronized(writeLock) {
            try {
                cmd.outputStream.write(data)
                cmd.outputStream.flush()
            } catch (_: IOException) {
                // channel closed: the close callback reports it
            }
        }
    }

    override fun end() {
        synchronized(writeLock) { runCatching { cmd.outputStream.close() } }
    }

    override fun close() {
        resume()
        // sshj waits for the remote side's CLOSE; on a dead link that is up to its 30 s timeout
        thread(name = "cs-ch-close", isDaemon = true) { runCatching { cmd.close() } }
    }

    override fun setWindow(cols: Int, rows: Int) {
        runCatching { (cmd as SessionChannel).changeWindowDimensions(cols, rows, 0, 0) }
    }

    override fun pause() {
        lock.withLock { paused = true }
    }

    override fun resume() {
        lock.withLock {
            paused = false
            unpaused.signalAll()
        }
    }
}
