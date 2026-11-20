package io.github.claudespace.core

import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// Files for Claude Code chats (a port of src/main/attach.ts). Claude Code runs on the VM and sees only files there, so
// a file from the phone goes to ~/.cache/claudespace over SFTP and its path is typed into the chat. Images (by magic
// bytes) become attachments in Claude Code; any other path stays text and Claude reads the file by it.

const val IMAGE_MAX_BYTES = 20 * 1024 * 1024
const val ATTACH_MAX_BYTES = 100 * 1024 * 1024
private const val KEEP_DAYS = 7

sealed class UploadResult {
    data class Ok(val path: String) : UploadResult()
    data class Failed(val error: String) : UploadResult()
}

/** image type by magic bytes (never by file name); null = not an image Claude Code reads */
fun imageExt(b: ByteArray): String? {
    fun at(i: Int, vararg v: Int) = v.withIndex().all { (j, x) -> i + j < b.size && (b[i + j].toInt() and 0xff) == x }
    return when {
        at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) -> "png"
        at(0, 0xff, 0xd8, 0xff) -> "jpg"
        at(0, 0x47, 0x49, 0x46, 0x38) -> "gif"
        at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50) -> "webp"
        else -> null
    }
}

private fun String.takeCodePoints(n: Int): String {
    val end = if (codePointCount(0, length) <= n) length else offsetByCodePoints(0, n)
    return substring(0, end)
}

/**
 * The file name as it lands on the VM. The path is pasted into the prompt unquoted, so only letters (any script),
 * digits, «.», «_» and «-» stay; runs of anything else become one «_». The extension is kept: Claude goes by it.
 */
fun attachName(name: String): String {
    val base = java.text.Normalizer.normalize(name.split('/', '\\').last(), java.text.Normalizer.Form.NFC)
    val dot = base.lastIndexOf('.')
    val rawStem = if (dot > 0) base.substring(0, dot) else base
    val rawExt = if (dot > 0) base.substring(dot + 1) else ""
    val stem = rawStem
        .replace(Regex("[^\\p{L}\\p{M}\\p{N}._-]+"), "_")
        .replace(Regex("_{2,}"), "_")
        .replace(Regex("^[._-]+|[._-]+$"), "")
        .takeCodePoints(80)
    val ext = rawExt.replace(Regex("[^\\p{L}\\p{M}\\p{N}]+"), "").takeCodePoints(12)
    return stem.ifEmpty { "file" } + if (ext.isEmpty()) "" else ".$ext"
}

private fun sha16(data: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(data).toHex().take(16)

/**
 * Put data at ~/.cache/claudespace/<dir>/<rel>. Files are named by their content, so the same file sent twice is one
 * file on the VM: uploaded once, its date refreshed so the weekly cleanup keeps it.
 */
private suspend fun putInCache(t: Transport, dir: String, rel: String, data: ByteArray): UploadResult {
    val r = execCollect(
        t,
        "d=\"\$HOME/.cache/claudespace/$dir\"; mkdir -p \"\$d\" && chmod 700 \"\$d\" && " +
            "find \"\$d\" -type f -mtime +$KEEP_DAYS -delete 2>/dev/null; " +
            "find \"\$d\" -mindepth 1 -type d -empty -delete 2>/dev/null; " +
            "f=\"\$d\"/${shq(rel)}; mkdir -p \"\$(dirname \"\$f\")\" && " +
            "if [ -f \"\$f\" ] && touch \"\$f\"; then printf 'have\\n'; else printf 'new\\n'; fi; printf %s \"\$d\"",
    )
    val lines = r.stdout.split('\n')
    val state = lines.getOrNull(0)
    val base = lines.getOrNull(1) ?: ""
    if (r.code != 0 || !base.startsWith("/")) return UploadResult.Failed(r.stderr.trim().ifEmpty { "Не удалось создать папку" })
    val path = "$base/$rel"
    if (state != "have") withContext(Dispatchers.IO) { t.writeFile(path, data, 0b110_000_000) }
    return UploadResult.Ok(path)
}

/** A file from the phone: images to images/, anything else to files/<sha16>/<name> with a readable name. */
suspend fun uploadAttachment(t: Transport?, name: String, data: ByteArray): UploadResult {
    if (t == null) return UploadResult.Failed("Нет связи с VM")
    val ext = imageExt(data)
    if (ext != null) {
        if (data.size > IMAGE_MAX_BYTES) return UploadResult.Failed("Картинка больше ${IMAGE_MAX_BYTES / 1024 / 1024} МБ")
        return putInCache(t, "images", "img-${sha16(data)}.$ext", data)
    }
    if (data.size > ATTACH_MAX_BYTES) return UploadResult.Failed("Файл больше ${ATTACH_MAX_BYTES / 1024 / 1024} МБ")
    return putInCache(t, "files", "${sha16(data)}/${attachName(name)}", data)
}
