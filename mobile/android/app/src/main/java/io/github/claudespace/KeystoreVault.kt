package io.github.claudespace

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import io.github.claudespace.core.KeyVault
import io.github.claudespace.core.SshKey
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The phone's SSH key, encrypted at rest with an AES key that never leaves the Android Keystore. The file holds
 * the IV and the ciphertext of the OpenSSH text; without this device's Keystore it is useless.
 */
class KeystoreVault(private val file: File, private val comment: String) : KeyVault {
    private fun secret(): SecretKey {
        val ks = KeyStore.getInstance(STORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    @Synchronized
    override fun loadOrCreate(): SshKey {
        if (file.isFile) {
            try {
                val bytes = file.readBytes()
                val ivLen = bytes[0].toInt()
                val c = Cipher.getInstance(TRANSFORM)
                c.init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, bytes, 1, ivLen))
                return SshKey.parse(c.doFinal(bytes, 1 + ivLen, bytes.size - 1 - ivLen).decodeToString())
            } catch (e: Exception) {
                // the Keystore key is gone (the app data was moved): keep the old file aside, make a new key; the
                // connect screen then shows the new public key to add on the VM
                Log.w("ClaudeSpace", "phone key unreadable, making a new one: $e")
                file.renameTo(File(file.path + ".unreadable"))
            }
        }
        val key = SshKey.generate(comment)
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.ENCRYPT_MODE, secret())
        val iv = c.iv
        val ct = c.doFinal(key.privateOpenSsh().toByteArray())
        file.parentFile?.mkdirs()
        val tmp = File(file.path + ".tmp")
        tmp.writeBytes(byteArrayOf(iv.size.toByte()) + iv + ct)
        tmp.renameTo(file)
        return key
    }

    private companion object {
        const val STORE = "AndroidKeyStore"
        const val ALIAS = "claudespace-phone-key"
        const val TRANSFORM = "AES/GCM/NoPadding"
    }
}
