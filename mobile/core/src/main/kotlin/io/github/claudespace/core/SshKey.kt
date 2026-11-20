package io.github.claudespace.core

import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import kotlin.io.encoding.Base64
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters

/**
 * The app's own ed25519 key. The phone creates it once; its public line goes into ~/.ssh/authorized_keys on the VM.
 * Stored and handed to sshj in the OpenSSH format (openssh-key-v1, unencrypted): `ssh-keygen` reads the same text,
 * so the key can be checked or reused elsewhere. Encryption at rest is the platform's job (Android Keystore).
 */
class SshKey private constructor(private val seed: ByteArray, val comment: String) {
    private val pub: ByteArray = Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().encoded

    /** SSH wire blob: string "ssh-ed25519", string key */
    val publicBlob: ByteArray = sshBytes { str(TYPE); str(pub) }

    /** the authorized_keys line */
    val publicOpenSsh: String
        get() = "$TYPE ${Base64.encode(publicBlob)}" + if (comment.isEmpty()) "" else " $comment"

    /** SHA256:… as `ssh-keygen -l` prints it */
    val fingerprint: String
        get() = fingerprintOf(publicBlob)

    fun privateOpenSsh(): String {
        val check = SecureRandom().nextInt()
        val private = sshBytes {
            int(check)
            int(check)
            str(TYPE)
            str(pub)
            str(seed + pub)
            str(comment.toByteArray())
            var pad = 1
            while (size() % 8 != 0) out.write(pad++)
        }
        val body = sshBytes {
            out.write(MAGIC)
            str("none")
            str("none")
            str(ByteArray(0))
            int(1)
            str(publicBlob)
            str(private)
        }
        val b64 = Base64.encode(body).chunked(70).joinToString("\n")
        return "$BEGIN\n$b64\n$END\n"
    }

    companion object {
        private const val TYPE = "ssh-ed25519"
        private const val BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----"
        private const val END = "-----END OPENSSH PRIVATE KEY-----"
        private val MAGIC = "openssh-key-v1\u0000".toByteArray()

        fun generate(comment: String): SshKey {
            val seed = ByteArray(32)
            SecureRandom().nextBytes(seed)
            return SshKey(seed, comment)
        }

        /** Reads an unencrypted openssh-key-v1 ed25519 key (what privateOpenSsh writes). */
        fun parse(text: String): SshKey {
            val b64 = text.lineSequence().map { it.trim() }
                .dropWhile { it != BEGIN }.drop(1).takeWhile { it != END }.joinToString("")
            require(b64.isNotEmpty()) { "not an OpenSSH private key" }
            val inp = DataInputStream(Base64.decode(b64).inputStream())
            val magic = ByteArray(MAGIC.size).also { inp.readFully(it) }
            require(magic.contentEquals(MAGIC)) { "not an OpenSSH private key" }
            require(inp.str().decodeToString() == "none" && inp.str().decodeToString() == "none") {
                "encrypted keys are not supported"
            }
            inp.str()
            require(inp.readInt() == 1) { "one key expected" }
            inp.str()
            val p = DataInputStream(inp.str().inputStream())
            require(p.readInt() == p.readInt()) { "corrupt key" }
            require(p.str().decodeToString() == TYPE) { "only ed25519 keys are supported" }
            val pub = p.str()
            val both = p.str()
            require(both.size == 64 && both.copyOfRange(32, 64).contentEquals(pub)) { "corrupt key" }
            val key = SshKey(both.copyOfRange(0, 32), p.str().decodeToString())
            require(key.pub.contentEquals(pub)) { "corrupt key" }
            return key
        }
    }
}

/** SHA256:… fingerprint of an SSH public key blob, without base64 padding (as OpenSSH prints it). */
fun fingerprintOf(blob: ByteArray): String =
    "SHA256:" + Base64.encode(MessageDigest.getInstance("SHA-256").digest(blob)).trimEnd('=')

internal class SshWriter {
    val out = ByteArrayOutputStream()
    private val data = DataOutputStream(out)
    fun int(v: Int) = data.writeInt(v)
    fun str(s: String) = str(s.toByteArray())
    fun str(b: ByteArray) {
        data.writeInt(b.size)
        data.write(b)
    }
    fun size() = out.size()
}

internal fun sshBytes(build: SshWriter.() -> Unit): ByteArray = SshWriter().apply(build).out.toByteArray()

private fun DataInputStream.str(): ByteArray {
    val n = readInt()
    require(n in 0..(1 shl 20)) { "corrupt key" }
    return ByteArray(n).also { readFully(it) }
}
