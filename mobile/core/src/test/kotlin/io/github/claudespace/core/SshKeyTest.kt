package io.github.claudespace.core

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.jupiter.api.AfterEach

// The key the phone creates must be a normal OpenSSH key: ssh-keygen reads it and derives the same public line and
// fingerprint, and a key made by ssh-keygen reads back here.
class SshKeyTest {
    private val dir: File = Files.createTempDirectory("cs-key-").toFile()

    @AfterEach
    fun cleanup() {
        dir.deleteRecursively()
    }

    private fun write(name: String, text: String) = File(dir, name).apply {
        writeText(text)
        setReadable(false, false)
        setWritable(false, false)
        setReadable(true, true)
        setWritable(true, true)
    }

    @Test
    fun `round trip keeps the key and the comment`() {
        val k = SshKey.generate("ClaudeSpace phone")
        val back = SshKey.parse(k.privateOpenSsh())
        assertEquals(k.publicOpenSsh, back.publicOpenSsh)
        assertEquals("ClaudeSpace phone", back.comment)
        assertTrue(k.publicOpenSsh.startsWith("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA"))
        assertTrue(k.publicOpenSsh.endsWith(" ClaudeSpace phone"))
        assertTrue(Regex("^SHA256:[A-Za-z0-9+/]{43}$").matches(k.fingerprint))
    }

    @Test
    fun `ssh-keygen reads our key`() {
        val k = SshKey.generate("phone")
        val f = write("id_phone", k.privateOpenSsh())
        val pub = run("ssh-keygen", "-y", "-f", f.path).trim()
        assertEquals(k.publicOpenSsh.split(" ").take(2), pub.split(" ").take(2))
        val fp = run("ssh-keygen", "-l", "-f", f.path).trim()
        assertTrue(fp.contains(k.fingerprint), "$fp vs ${k.fingerprint}")
    }

    @Test
    fun `reads a key made by ssh-keygen`() {
        val f = File(dir, "id_made")
        run("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "made here", "-f", f.path)
        val k = SshKey.parse(f.readText())
        assertEquals(File(dir, "id_made.pub").readText().trim(), k.publicOpenSsh)
    }

    @Test
    fun `refuses encrypted, other types and garbage`() {
        val enc = File(dir, "id_enc")
        run("ssh-keygen", "-q", "-t", "ed25519", "-N", "secret", "-f", enc.path)
        assertFailsWith<IllegalArgumentException> { SshKey.parse(enc.readText()) }
        val ec = File(dir, "id_ec")
        run("ssh-keygen", "-q", "-t", "ecdsa", "-N", "", "-f", ec.path)
        assertFailsWith<IllegalArgumentException> { SshKey.parse(ec.readText()) }
        assertFailsWith<IllegalArgumentException> { SshKey.parse("not a key") }
    }
}
