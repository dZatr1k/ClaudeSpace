package io.github.claudespace.core

import java.io.File
import java.nio.file.Files
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.io.encoding.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// The same cases as tests/unit/hostkey.node.test.ts: the phone checks host keys the way the PC does.
class KnownHostsTest {
    private fun blob(type: String, payload: String) = sshBytes { str(type) } + payload.toByteArray()
    private val a = blob("ssh-ed25519", "key-A")
    private val b = blob("ssh-ed25519", "key-B")
    private val r = blob("ssh-rsa", "key-R")
    private fun b64(x: ByteArray) = Base64.encode(x)

    private fun hashed(host: String): String {
        val salt = ByteArray(20).also { SecureRandom().nextBytes(it) }
        val mac = Mac.getInstance("HmacSHA1").apply { init(SecretKeySpec(salt, "HmacSHA1")) }
        return "|1|${b64(salt)}|${b64(mac.doFinal(host.toByteArray()))}"
    }

    @Test
    fun `hostToken uses host-port brackets for non-22`() {
        assertEquals("vm", KnownHosts.hostToken("vm", 22))
        assertEquals("[1.2.3.4]:2222", KnownHosts.hostToken("1.2.3.4", 2222))
    }

    @Test
    fun `plain entries - match, mismatch, unknown`() {
        val e = KnownHosts.parse("# comment\n203.0.113.10,vm ssh-ed25519 ${b64(a)}\n")
        assertEquals(HostKeyResult.MATCH, KnownHosts.check(e, "203.0.113.10", 22, a))
        assertEquals(HostKeyResult.MATCH, KnownHosts.check(e, "vm", 22, a))
        assertEquals(HostKeyResult.MISMATCH, KnownHosts.check(e, "203.0.113.10", 22, b))
        assertEquals(HostKeyResult.UNKNOWN, KnownHosts.check(e, "other", 22, a))
        // another key type for a known host is not a mismatch (ssh would ask)
        assertEquals(HostKeyResult.UNKNOWN, KnownHosts.check(e, "vm", 22, r))
    }

    @Test
    fun `host-port entries`() {
        val e = KnownHosts.parse("[127.0.0.1]:2222 ssh-ed25519 ${b64(a)}")
        assertEquals(HostKeyResult.MATCH, KnownHosts.check(e, "127.0.0.1", 2222, a))
        assertEquals(HostKeyResult.UNKNOWN, KnownHosts.check(e, "127.0.0.1", 22, a))
        assertEquals(HostKeyResult.MISMATCH, KnownHosts.check(e, "127.0.0.1", 2222, b))
    }

    @Test
    fun `hashed entries, plain and with port`() {
        val e = KnownHosts.parse("${hashed("203.0.113.10")} ssh-ed25519 ${b64(a)}\n${hashed("[vm]:2200")} ssh-ed25519 ${b64(b)}")
        assertEquals(HostKeyResult.MATCH, KnownHosts.check(e, "203.0.113.10", 22, a))
        assertEquals(HostKeyResult.MISMATCH, KnownHosts.check(e, "203.0.113.10", 22, b))
        assertEquals(HostKeyResult.MATCH, KnownHosts.check(e, "vm", 2200, b))
        assertEquals(HostKeyResult.UNKNOWN, KnownHosts.check(e, "vm", 22, b))
    }

    @Test
    fun `wildcards, negation, markers`() {
        val e = KnownHosts.parse(
            "*.lan,!bad.lan ssh-ed25519 ${b64(a)}\n@revoked * ssh-ed25519 ${b64(b)}\n@cert-authority * ssh-ed25519 ${b64(r)}",
        )
        assertEquals(HostKeyResult.MATCH, KnownHosts.check(e, "pc.lan", 22, a))
        assertEquals(HostKeyResult.UNKNOWN, KnownHosts.check(e, "bad.lan", 22, a))
        assertEquals(HostKeyResult.MISMATCH, KnownHosts.check(e, "pc.lan", 22, b))
        assertEquals(listOf("ssh-ed25519"), KnownHosts.knownTypes(e, "pc.lan", 22))
    }

    @Test
    fun `keyTypeOf and fingerprint`() {
        assertEquals("ssh-ed25519", KnownHosts.keyTypeOf(a))
        assertEquals("", KnownHosts.keyTypeOf(byteArrayOf(0, 0, 0, 99, 1)))
        assertTrue(Regex("^SHA256:[A-Za-z0-9+/]+$").matches(fingerprintOf(a)))
    }

    @Test
    fun `TOFU file - trust, read back, forget`() {
        val dir = Files.createTempDirectory("cs-kh-").toFile()
        try {
            val f = File(dir, "sub/known_hosts")
            KnownHosts.trust(f, "127.0.0.1", 2222, a)
            KnownHosts.trust(f, "vm", 22, b)
            assertFalse(Files.getPosixFilePermissions(f.toPath()).any { it.name.startsWith("GROUP") || it.name.startsWith("OTHERS") })
            val e = KnownHosts.read(f) + KnownHosts.read(File(dir, "missing"))
            assertEquals(HostKeyResult.MATCH, KnownHosts.check(e, "127.0.0.1", 2222, a))
            assertEquals(HostKeyResult.MATCH, KnownHosts.check(e, "vm", 22, b))
            KnownHosts.forget(f, "127.0.0.1", 2222)
            assertFalse(f.readText().contains("127.0.0.1"))
            assertEquals(HostKeyResult.MATCH, KnownHosts.check(KnownHosts.read(f), "vm", 22, b))
        } finally {
            dir.deleteRecursively()
        }
    }
}
