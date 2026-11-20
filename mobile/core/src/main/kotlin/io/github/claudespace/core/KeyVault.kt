package io.github.claudespace.core

import java.io.File

/** Where the phone's key lives. On Android it is encrypted with a key from the Android Keystore (KeystoreVault). */
interface KeyVault {
    /** the key, created on first use */
    fun loadOrCreate(): SshKey
}

/** A plain file readable only by the owner: tests and the JVM. */
class FileKeyVault(private val file: File, private val comment: String = "ClaudeSpace phone") : KeyVault {
    override fun loadOrCreate(): SshKey {
        if (file.isFile) return SshKey.parse(file.readText())
        val key = SshKey.generate(comment)
        file.parentFile?.mkdirs()
        file.writeText(key.privateOpenSsh())
        file.setReadable(false, false)
        file.setWritable(false, false)
        file.setReadable(true, true)
        file.setWritable(true, true)
        return key
    }
}
