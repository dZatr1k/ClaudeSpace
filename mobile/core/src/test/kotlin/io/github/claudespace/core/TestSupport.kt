package io.github.claudespace.core

import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import java.nio.file.Files
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlinx.serialization.json.JsonElement
import org.apache.sshd.common.config.keys.PublicKeyEntry
import org.apache.sshd.common.file.nativefs.NativeFileSystemFactory
import org.apache.sshd.common.keyprovider.KeyPairProvider
import org.apache.sshd.server.Environment
import org.apache.sshd.server.ExitCallback
import org.apache.sshd.server.Signal
import org.apache.sshd.server.SshServer
import org.apache.sshd.server.channel.ChannelSession
import org.apache.sshd.server.command.Command
import org.apache.sshd.server.command.CommandFactory
import org.apache.sshd.sftp.server.SftpFileSystemAccessor
import org.apache.sshd.sftp.server.SftpSubsystemFactory
import org.apache.sshd.sftp.server.SftpSubsystemProxy

// Test fixtures: the repo, the real agent bundle, a fake HOME built by the agent's Python fixture, a tmux server of
// our own (never the user's), and an in-process SSH server (Apache MINA SSHD) that runs commands as the VM's sshd
// would: through bash, in the fake HOME, on a PTY when asked (resources/ptyhelper.py, as the Node tests do).

object Env {
    val root = File(System.getProperty("cs.root") ?: error("run through Gradle: cs.root is not set"))
    val bundle = DirBundle(File(System.getProperty("cs.bundle")))
    val bundleManifest: Manifest get() = bundle.manifest
    val ptyHelper = File(root, "resources/ptyhelper.py")
    val tmuxSocket = "claudespace-test-kt-${ProcessHandle.current().pid()}"
}

fun run(vararg cmd: String, cwd: File? = null): String {
    val p = ProcessBuilder(*cmd).directory(cwd).redirectErrorStream(true).start()
    val out = p.inputStream.readBytes().toString(Charsets.UTF_8)
    p.waitFor(30, TimeUnit.SECONDS)
    return out
}

class FakeHome private constructor(val home: File) : AutoCloseable {
    val alpha = File(home, "projects/Alpha")
    override fun close() {
        home.deleteRecursively()
    }

    companion object {
        fun create(): FakeHome {
            val out = run(
                "python3", "-c",
                "import sys; sys.path.insert(0, 'agent'); from tests.fixtures import FakeHome; print(FakeHome().home)",
                cwd = Env.root,
            ).trim().lines().last()
            return FakeHome(File(out))
        }
    }
}

fun tmux(vararg args: String): String = run("tmux", "-L", Env.tmuxSocket, *args)

fun killTmux() {
    run("tmux", "-L", Env.tmuxSocket, "kill-server")
    val dir = System.getenv("TMUX_TMPDIR") ?: "/tmp"
    File("$dir/tmux-${run("id", "-u").trim()}/${Env.tmuxSocket}").delete()
}

fun <T : Any> waitFor(what: String, timeoutMs: Long = 10_000, cond: () -> T?): T {
    val end = System.currentTimeMillis() + timeoutMs
    while (true) {
        val v = cond()
        if (v != null && v != false) return v
        if (System.currentTimeMillis() > end) throw AssertionError("timeout waiting for $what")
        Thread.sleep(50)
    }
}

fun ecHostKey(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()

/** Collects what a Connection reports. */
class Recorder : ConnectionListener {
    val states = CopyOnWriteArrayList<ConnState>()
    val events = CopyOnWriteArrayList<Pair<String, JsonElement>>()
    override fun state(s: ConnState) {
        states += s
    }
    override fun event(name: String, data: JsonElement) {
        events += name to data
    }
    override fun log(line: String) {
        if (System.getenv("CS_DEBUG") != null) System.err.println(line)
    }
    inline fun <reified T : ConnState> firstAfter(from: Int = 0): T? = states.drop(from).filterIsInstance<T>().firstOrNull()
}

class TestSshd(
    private val home: File,
    private val allowedPublic: String,
    hostKey: KeyPair = ecHostKey(),
    port: Int = 0,
    /** PATH for the commands (default: inherited) */
    private val path: String? = null,
) : AutoCloseable {
    val execs = CopyOnWriteArrayList<String>()
    private val fifoDir: File = Files.createTempDirectory("cs-sshd-").toFile()
    private val seq = AtomicInteger()
    private val server: SshServer = SshServer.setUpDefaultServer().apply {
        host = "127.0.0.1"
        this.port = port
        keyPairProvider = KeyPairProvider.wrap(hostKey)
        publickeyAuthenticator = org.apache.sshd.server.auth.pubkey.PublickeyAuthenticator { _, key, _ ->
            PublicKeyEntry.toString(key).split(" ")[1] == allowedPublic.split(" ")[1]
        }
        passwordAuthenticator = null
        keyboardInteractiveAuthenticator = null
        commandFactory = CommandFactory { _, cmd -> ProcessCommand(cmd) }
        // SFTP paths as the VM's sshd treats them: relative ones from HOME, absolute ones as they are
        subsystemFactories = listOf(
            SftpSubsystemFactory().apply {
                fileSystemAccessor = object : SftpFileSystemAccessor {
                    override fun resolveLocalFilePath(
                        subsystem: SftpSubsystemProxy,
                        rootDir: java.nio.file.Path,
                        remotePath: String,
                    ): java.nio.file.Path =
                        if (remotePath.startsWith("/")) java.nio.file.Paths.get(remotePath) else home.toPath().resolve(remotePath)
                }
            },
        )
        fileSystemFactory = NativeFileSystemFactory()
    }

    init {
        server.start()
    }

    val port: Int get() = server.port

    /** close every client connection at once (a network drop as the client sees it) */
    fun dropClients() {
        server.activeSessions.forEach { it.close(true) }
    }

    override fun close() {
        server.stop(true)
        fifoDir.deleteRecursively()
    }

    private inner class ProcessCommand(private val command: String) : Command {
        private lateinit var inp: InputStream
        private lateinit var out: OutputStream
        private lateinit var err: OutputStream
        private lateinit var exit: ExitCallback
        @Volatile private var proc: Process? = null
        private var ctl: RandomAccessFile? = null

        override fun setInputStream(`in`: InputStream) {
            inp = `in`
        }
        override fun setOutputStream(out: OutputStream) {
            this.out = out
        }
        override fun setErrorStream(err: OutputStream) {
            this.err = err
        }
        override fun setExitCallback(callback: ExitCallback) {
            exit = callback
        }

        override fun start(channel: ChannelSession, env: Environment) {
            execs += command
            val cols = env.env[Environment.ENV_COLUMNS]?.toIntOrNull()
            val pb = if (cols != null) {
                val rows = env.env[Environment.ENV_LINES]?.toIntOrNull() ?: 24
                // resize lines go to the helper's fd 3: a FIFO both sides open read-write, so neither open blocks
                val fifo = File(fifoDir, "ctl-${seq.incrementAndGet()}")
                run("mkfifo", "-m", "600", fifo.path)
                val c = RandomAccessFile(fifo, "rw")
                ctl = c
                env.addSignalListener({ _, _ ->
                    val r = env.env[Environment.ENV_LINES]
                    val k = env.env[Environment.ENV_COLUMNS]
                    runCatching { synchronized(c) { c.write("$r $k\n".toByteArray()) } }
                }, Signal.WINCH)
                ProcessBuilder(
                    "/bin/bash", "-c", "exec python3 -I \"$0\" \"$1\" \"$2\" /bin/bash -c \"$3\" 3<>\"$4\"",
                    Env.ptyHelper.path, rows.toString(), cols.toString(), command, fifo.path,
                )
            } else {
                ProcessBuilder("/bin/bash", "-c", command)
            }
            pb.directory(home)
            pb.environment().apply {
                put("HOME", home.path)
                put("TERM", "xterm-256color")
                remove("TMUX")
                remove("TMUX_PANE")
                remove("CLAUDESPACE_APP")
                if (path != null) put("PATH", path)
            }
            val p = pb.start()
            proc = p
            val o = thread(isDaemon = true) { pipe(p.inputStream, out) }
            val e = thread(isDaemon = true) { pipe(p.errorStream, err) }
            thread(isDaemon = true) {
                runCatching {
                    val buf = ByteArray(32 * 1024)
                    while (true) {
                        val n = inp.read(buf)
                        if (n < 0) break
                        p.outputStream.write(buf, 0, n)
                        p.outputStream.flush()
                    }
                }
                runCatching { p.outputStream.close() }
            }
            thread(isDaemon = true) {
                val code = p.waitFor()
                o.join(5000)
                e.join(5000)
                runCatching { ctl?.close() }
                exit.onExit(code)
            }
        }

        private fun pipe(from: InputStream, to: OutputStream) {
            runCatching {
                val buf = ByteArray(32 * 1024)
                while (true) {
                    val n = from.read(buf)
                    if (n < 0) break
                    to.write(buf, 0, n)
                    to.flush()
                }
            }
        }

        override fun destroy(channel: ChannelSession) {
            proc?.destroy()
            runCatching { ctl?.close() }
        }
    }
}
