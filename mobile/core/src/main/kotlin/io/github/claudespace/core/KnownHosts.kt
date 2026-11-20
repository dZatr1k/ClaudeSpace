package io.github.claudespace.core

import java.io.File
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.io.encoding.Base64

// Host key verification against the app's own known_hosts (TOFU): plain, [host]:port and hashed |1|salt|hash entries,
// wildcards, negation, @revoked. A port of src/main/ssh/hostkey.ts; the phone has no ~/.ssh/known_hosts of its own.

enum class HostKeyResult { MATCH, MISMATCH, UNKNOWN }

class KnownHostEntry(
    /** null for hashed entries */
    val hosts: List<String>?,
    val salt: ByteArray?,
    val hash: ByteArray?,
    val keyType: String,
    /** base64 blob */
    val key: String,
    val marker: String?,
)

object KnownHosts {
    /** The host pattern ssh uses: `host` for port 22, `[host]:port` otherwise. */
    fun hostToken(host: String, port: Int): String = if (port == 22) host else "[$host]:$port"

    fun parse(text: String): List<KnownHostEntry> {
        val out = mutableListOf<KnownHostEntry>()
        for (raw in text.lines()) {
            val line = raw.trim()
            if (line.isEmpty() || line.startsWith("#")) continue
            val parts = line.split(Regex("\\s+")).toMutableList()
            val marker = if (parts[0].startsWith("@")) parts.removeAt(0) else null
            if (parts.size < 3) continue
            val (hostField, keyType, key) = parts
            if (hostField.startsWith("|1|")) {
                val f = hostField.split("|")
                if (f.size < 4 || f[2].isEmpty() || f[3].isEmpty()) continue
                val salt = runCatching { Base64.decode(f[2]) }.getOrNull() ?: continue
                val hash = runCatching { Base64.decode(f[3]) }.getOrNull() ?: continue
                out += KnownHostEntry(null, salt, hash, keyType, key, marker)
            } else {
                out += KnownHostEntry(hostField.split(","), null, null, keyType, key, marker)
            }
        }
        return out
    }

    private fun globToRe(p: String): Regex {
        val sb = StringBuilder("^")
        for (c in p) {
            when (c) {
                '*' -> sb.append(".*")
                '?' -> sb.append('.')
                else -> sb.append(Regex.escape(c.toString()))
            }
        }
        return Regex(sb.append('$').toString(), RegexOption.IGNORE_CASE)
    }

    fun matches(e: KnownHostEntry, token: String): Boolean {
        if (e.salt != null && e.hash != null) {
            val mac = Mac.getInstance("HmacSHA1")
            mac.init(SecretKeySpec(e.salt, "HmacSHA1"))
            return mac.doFinal(token.toByteArray()).contentEquals(e.hash)
        }
        var ok = false
        for (pat in e.hosts.orEmpty()) {
            if (pat.startsWith("!")) {
                if (globToRe(pat.substring(1)).matches(token)) return false
            } else if (globToRe(pat).matches(token)) ok = true
        }
        return ok
    }

    /** key type from an SSH public key blob (uint32 length + name) */
    fun keyTypeOf(blob: ByteArray): String {
        if (blob.size < 4) return ""
        val n = ((blob[0].toInt() and 0xff) shl 24) or ((blob[1].toInt() and 0xff) shl 16) or
            ((blob[2].toInt() and 0xff) shl 8) or (blob[3].toInt() and 0xff)
        if (n < 0 || 4 + n > blob.size) return ""
        return blob.copyOfRange(4, 4 + n).decodeToString()
    }

    /**
     * MATCH: some entry for this host has this key. MISMATCH: entries for this host with the same key type exist and
     * none matches (or a @revoked entry matches). UNKNOWN: no entry for this host (or only other key types).
     */
    fun check(entries: List<KnownHostEntry>, host: String, port: Int, blob: ByteArray): HostKeyResult {
        val token = hostToken(host, port)
        val b64 = Base64.encode(blob)
        val type = keyTypeOf(blob)
        var sameType = false
        for (e in entries) {
            if (!matches(e, token)) continue
            if (e.marker == "@revoked" && e.key == b64) return HostKeyResult.MISMATCH
            if (e.marker != null) continue
            if (e.key == b64) return HostKeyResult.MATCH
            if (e.keyType == type) sameType = true
        }
        return if (sameType) HostKeyResult.MISMATCH else HostKeyResult.UNKNOWN
    }

    /** key types known for host:port (sshj offers them first, so the server shows the key we already trust) */
    fun knownTypes(entries: List<KnownHostEntry>, host: String, port: Int): List<String> {
        val token = hostToken(host, port)
        return entries.filter { it.marker == null && matches(it, token) }.map { it.keyType }.distinct()
    }

    fun read(file: File): List<KnownHostEntry> = if (file.isFile) parse(file.readText()) else emptyList()

    /** TOFU: append host:port with this key to the app's file. */
    fun trust(file: File, host: String, port: Int, blob: ByteArray) {
        file.parentFile?.mkdirs()
        val fresh = !file.exists()
        file.appendText("${hostToken(host, port)} ${keyTypeOf(blob)} ${Base64.encode(blob)}\n")
        if (fresh) restrict(file)
    }

    /** Forget trusted keys for host:port. */
    fun forget(file: File, host: String, port: Int) {
        if (!file.isFile) return
        val token = hostToken(host, port)
        val keep = file.readLines().filter { l -> l.isNotBlank() && parse(l).none { matches(it, token) } }
        file.writeText(if (keep.isEmpty()) "" else keep.joinToString("\n") + "\n")
    }

    private fun restrict(f: File) {
        f.setReadable(false, false)
        f.setWritable(false, false)
        f.setReadable(true, true)
        f.setWritable(true, true)
    }
}
