package io.github.claudespace.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// The same commands as tests/unit/terminals.node.test.ts, plus flow control with a fake channel.
class TerminalsTest {
    @Test
    fun `tmux attach uses an exact target and -u`() {
        assertTrue(terminalCommand(TermSpec.Tmux("MyApp-2")).contains("exec tmux -u attach-session -t '=MyApp-2'"))
        assertTrue(terminalCommand(TermSpec.Tmux("a"), "sock").contains("tmux -L 'sock' -u attach-session"))
    }

    @Test
    fun `exports this connection's app id before exec`() {
        val id = "0123456789abcdef"
        for (spec in listOf(TermSpec.Tmux("a"), TermSpec.Shell(), TermSpec.Lazygit(), TermSpec.Yazi())) {
            val c = terminalCommand(spec, null, id)
            assertTrue(c.contains("export CLAUDESPACE_APP=$id;"), c)
            assertTrue(c.indexOf("CLAUDESPACE_APP") < c.indexOf("exec "))
        }
        assertFalse(terminalCommand(TermSpec.Tmux("a"), null, "\$(id)").contains("CLAUDESPACE_APP"))
        assertFalse(terminalCommand(TermSpec.Tmux("a")).contains("CLAUDESPACE_APP"))
    }

    @Test
    fun `refuses bad session names`() {
        assertFailsWith<IllegalArgumentException> { terminalCommand(TermSpec.Tmux("x'; rm -rf ~; '")) }
        assertFailsWith<IllegalArgumentException> { terminalCommand(TermSpec.Tmux("")) }
    }

    @Test
    fun `quotes paths for shell, lazygit, yazi`() {
        assertTrue(terminalCommand(TermSpec.Shell("/home/u/it's \$(id)")).contains("cd '/home/u/it'\\''s \$(id)' && exec bash -l"))
        assertTrue(terminalCommand(TermSpec.Shell("~")).contains("cd \"\$HOME\" &&"))
        assertTrue(terminalCommand(TermSpec.Lazygit("~/projects/a b")).contains("cd \"\$HOME\"/'projects/a b' && exec lazygit"))
        assertTrue(terminalCommand(TermSpec.Yazi("/x")).contains("exec yazi '/x'"))
    }

    @Test
    fun `git clone - url whitelist, quoted args, -- before url`() {
        val c = terminalCommand(TermSpec.Clone("https://github.com/a/b.git", "/home/u/projects/b"))
        assertTrue(c.contains("git clone -- 'https://github.com/a/b.git' '/home/u/projects/b'"))
        assertFailsWith<IllegalArgumentException> { terminalCommand(TermSpec.Clone("--upload-pack=touch /tmp/x", "/x")) }
        assertFailsWith<IllegalArgumentException> { terminalCommand(TermSpec.Clone("https://a/b c", "/x")) }
    }

    private class FakeChannel : ExecChannel {
        var listener: ChannelListener? = null
        var paused = false
        val written = mutableListOf<String>()
        var window: Pair<Int, Int>? = null
        var closed = false
        override fun start(listener: ChannelListener) {
            this.listener = listener
        }
        override fun write(data: ByteArray) {
            written += data.decodeToString()
        }
        override fun end() {}
        override fun close() {
            closed = true
        }
        override fun setWindow(cols: Int, rows: Int) {
            window = cols to rows
        }
        override fun pause() {
            paused = true
        }
        override fun resume() {
            paused = false
        }
    }

    private class FakeTransport : Transport {
        val channels = mutableListOf<Pair<String, FakeChannel>>()
        override fun exec(cmd: String, pty: Pty?): ExecChannel = FakeChannel().also { channels += cmd to it }
        override fun writeFile(path: String, data: ByteArray, mode: Int) {}
        override fun onClose(cb: (String) -> Unit) {}
        override val isOpen = true
        override fun close() {}
        override fun drop() {}
    }

    @Test
    fun `batches output, pauses past HIGH_WATER, resumes below LOW_WATER, reports exit`() {
        val got = java.util.concurrent.CopyOnWriteArrayList<Pair<String, Int>>()
        val exits = java.util.concurrent.CopyOnWriteArrayList<Triple<String, Int?, String?>>()
        val t = FakeTransport()
        val tm = TerminalManager(
            object : TerminalSink {
                override fun data(tabId: String, data: ByteArray) {
                    got += tabId to data.size
                }
                override fun exit(tabId: String, code: Int?, signal: String?) {
                    exits += Triple(tabId, code, signal)
                }
            },
            { t }, { null }, { "0123456789abcdef" },
        )
        tm.open("t1", TermSpec.Tmux("a"), 80, 24)
        val ch = t.channels.single().second
        assertTrue(t.channels.single().first.contains("CLAUDESPACE_APP=0123456789abcdef"))
        repeat(10) { ch.listener!!.data(ByteArray(100)) }
        waitFor("batch") { got.isNotEmpty() }
        Thread.sleep(30)
        assertEquals(listOf("t1" to 1000), got.toList(), "small writes arrive as one batch")
        ch.listener!!.data(ByteArray(HIGH_WATER))
        assertTrue(ch.paused)
        assertEquals(true, tm.stats("t1")?.paused)
        tm.ack("t1", HIGH_WATER)
        assertFalse(ch.paused)
        tm.write("t1", "x".toByteArray())
        tm.resize("t1", 100, 30)
        assertEquals(listOf("x"), ch.written)
        assertEquals(100 to 30, ch.window)
        ch.listener!!.closed(0, null)
        waitFor("exit") { exits.isNotEmpty() }
        assertEquals(Triple("t1", 0, null), exits.single())
        assertFalse(tm.has("t1"))
        // a closed or dropped tab reports nothing
        tm.open("t2", TermSpec.Shell(), 80, 24)
        val ch2 = t.channels.last().second
        tm.close("t2")
        assertTrue(ch2.closed)
        ch2.listener!!.closed(0, null)
        Thread.sleep(30)
        assertEquals(1, exits.size)
        tm.shutdown()
    }
}
