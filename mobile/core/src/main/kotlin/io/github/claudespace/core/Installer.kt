package io.github.claudespace.core

import java.io.File
import java.security.SecureRandom
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

// Install or update csagent on the VM (a port of src/main/agent/installer.ts): compare the MANIFEST hash, upload to a
// temp dir over SFTP, verify sha256 there, swap atomically. Also checks python3 >= 3.8 and tmux.

data class Manifest(
    val agent: String,
    /** the app release the bundle shipped with (package.json); missing in bundles before 0.7.11 */
    val app: String?,
    val protocol: Int,
    val files: Map<String, String>,
    val hash: String,
) {
    companion object {
        fun parse(text: String): Manifest {
            val o = Json.parseToJsonElement(text).jsonObject
            return Manifest(
                agent = o.getValue("agent").jsonPrimitive.content,
                app = o["app"]?.jsonPrimitive?.contentOrNull,
                protocol = o.getValue("protocol").jsonPrimitive.int,
                files = o.getValue("files").jsonObject.mapValues { it.value.jsonPrimitive.content },
                hash = o.getValue("hash").jsonPrimitive.content,
            )
        }
    }
}

/** The agent files the app ships (resources/agent on the PC; APK assets on the phone). */
interface AgentBundle {
    val manifestText: String
    fun read(rel: String): ByteArray
    val manifest: Manifest
        get() = Manifest.parse(manifestText)
}

/** A bundle in a directory, as `python3 agent/build_manifest.py` writes it. */
class DirBundle(private val dir: File) : AgentBundle {
    override val manifestText: String
        get() = File(dir, "MANIFEST.json").readText()

    override fun read(rel: String): ByteArray = File(dir, rel).readBytes()
}

const val REMOTE_DIR = ".local/lib/claudespace"

/** files run directly: csagent.py by the app, askpass.py by sudo, openurl.py as BROWSER */
val EXECUTABLE_FILES = setOf("csagent.py", "askpass.py", "openurl.py")

class InstallException(val reason: Reason, message: String) : Exception(message) {
    enum class Reason { NO_PYTHON, OLD_PYTHON, NO_TMUX, NEWER, VERIFY, UPLOAD }

    /** the user has to act on the VM (or update the app); retrying will not help */
    val needsUser: Boolean
        get() = reason != Reason.UPLOAD && reason != Reason.VERIFY
}

data class Probe(val python: String?, val pythonOk: Boolean, val tmux: String?, val installed: Manifest?)

private val PROBE = listOf(
    "printf \"py=%s\\n\" \"\$(command -v python3)\"",
    "printf \"pyok=%s\\n\" \"\$(python3 -I -c 'import sys; print(int(sys.version_info >= (3, 8)))' 2>/dev/null)\"",
    "printf \"tmux=%s\\n\" \"\$(command -v tmux)\"",
    "echo \"---\"",
    "cat ~/$REMOTE_DIR/MANIFEST.json 2>/dev/null",
).joinToString("; ")

suspend fun probe(t: Transport): Probe {
    val r = execCollect(t, PROBE)
    val head = r.stdout.substringBefore("---\n")
    val body = r.stdout.substringAfter("---\n", "")
    val kv = head.lines().mapNotNull { l ->
        val i = l.indexOf('=')
        if (i > 0) l.substring(0, i) to l.substring(i + 1).trim() else null
    }.toMap()
    val installed = if (body.isBlank()) null else runCatching { Manifest.parse(body) }.getOrNull()
    return Probe(kv["py"]?.ifEmpty { null }, kv["pyok"] == "1", kv["tmux"]?.ifEmpty { null }, installed)
}

private val VERIFY_PY = """
import hashlib, json, os, sys
d = sys.argv[1]
m = json.load(open(os.path.join(d, 'MANIFEST.json')))
for rel, sha in m['files'].items():
    if hashlib.sha256(open(os.path.join(d, rel), 'rb').read()).hexdigest() != sha:
        print('BAD ' + rel); sys.exit(3)
print('OK')
"""

private val VERSION_RE = Regex("^(\\d+)\\.(\\d+)\\.(\\d+)(?:-.*)?$")

/** a vs b as x.y.z release numbers (a "-suffix" is ignored): <0, 0, >0; null if either is not one. */
fun compareVersions(a: String?, b: String?): Int? {
    fun parse(v: String?) = VERSION_RE.matchEntire(v ?: "")?.groupValues?.drop(1)?.map { it.toInt() }
    val x = parse(a) ?: return null
    val y = parse(b) ?: return null
    for (i in 0 until 3) if (x[i] != y[i]) return x[i].compareTo(y[i])
    return 0
}

enum class InstallPlan { SAME, INSTALL, KEEP_NEWER, APP_TOO_OLD }

/**
 * What to do with the agent on the VM. Several apps share it (the PC and the phone update at different times), so an
 * agent of a newer release stays: replacing it would undo the other app's update. Within one protocol a newer agent
 * still serves an older app; a newer agent on another protocol means this app is too old.
 */
fun installPlan(installed: Manifest?, bundled: Manifest): InstallPlan {
    if (installed?.hash == bundled.hash) return InstallPlan.SAME
    if (installed == null || (compareVersions(installed.app, bundled.app) ?: 0) <= 0) return InstallPlan.INSTALL
    return if (installed.protocol == bundled.protocol) InstallPlan.KEEP_NEWER else InstallPlan.APP_TOO_OLD
}

/** installed: (re)installed; kept: the release of a newer agent left in place */
data class EnsureResult(val installed: Boolean, val kept: String?, val probe: Probe)

/** Ensure the bundled agent (or a newer one, see installPlan) is installed. */
suspend fun ensureAgent(t: Transport, bundle: AgentBundle, progress: (String) -> Unit = {}): EnsureResult {
    val bundled = bundle.manifest
    val p = probe(t)
    if (p.python == null) throw InstallException(InstallException.Reason.NO_PYTHON, "На VM нет python3")
    if (!p.pythonOk) throw InstallException(InstallException.Reason.OLD_PYTHON, "На VM python3 старше 3.8")
    if (p.tmux == null) throw InstallException(InstallException.Reason.NO_TMUX, "На VM нет tmux")
    when (installPlan(p.installed, bundled)) {
        InstallPlan.SAME -> return EnsureResult(false, null, p)
        InstallPlan.KEEP_NEWER -> return EnsureResult(false, p.installed?.app, p)
        InstallPlan.APP_TOO_OLD -> throw InstallException(
            InstallException.Reason.NEWER,
            "На VM стоит агент из ClaudeSpace ${p.installed?.app}, а это приложение старше и не может с ним " +
                "работать. Обновите приложение.",
        )
        InstallPlan.INSTALL -> Unit
    }

    val files = bundled.files.keys.sorted()
    val data = files.associateWith { bundle.read(it) } + ("MANIFEST.json" to bundle.manifestText.toByteArray())
    val kb = maxOf(1, Math.round(files.sumOf { data.getValue(it).size } / 1024.0).toInt())
    progress("Установка агента ($kb КБ)…")
    val name = "claudespace.tmp-" + ByteArray(4).also { SecureRandom().nextBytes(it) }.toHex()
    val tmp = ".local/lib/$name"
    val dirs = (listOf(tmp) + files.mapNotNull { f -> f.substringBeforeLast('/', "").ifEmpty { null } }
        .map { "$tmp/$it" }).distinct()
    val mk = execCollect(t, "mkdir -p -m 700 ${dirs.joinToString(" ") { "~/" + shq(it) }} && chmod 700 ~/${shq(tmp)}")
    if (mk.code != 0) throw InstallException(InstallException.Reason.UPLOAD, "mkdir: ${mk.stderr.trim()}")
    try {
        withContext(Dispatchers.IO) {
            for ((rel, bytes) in data) {
                t.writeFile("$tmp/$rel", bytes, if (rel in EXECUTABLE_FILES) 0b111_000_000 else 0b110_000_000)
            }
        }
    } catch (e: Exception) {
        runCatching { execCollect(t, "rm -rf ~/${shq(tmp)}") }
        throw InstallException(InstallException.Reason.UPLOAD, "загрузка: ${e.message}")
    }
    val script = listOf(
        "cd ~/.local/lib",
        "python3 -I -c ${shq(VERIFY_PY)} ${shq(name)}",
        "rm -rf claudespace.old",
        "{ [ ! -e claudespace ] || mv claudespace claudespace.old; }",
        "mv ${shq(name)} claudespace",
        "rm -rf claudespace.old",
    ).joinToString(" && ")
    val r = execCollect(t, script, 20_000)
    if (r.code != 0 || !r.stdout.contains("OK")) {
        runCatching { execCollect(t, "rm -rf ~/${shq(tmp)}") }
        throw InstallException(
            InstallException.Reason.VERIFY,
            "проверка sha256 не прошла: ${(r.stdout + r.stderr).trim().take(200)}",
        )
    }
    return EnsureResult(true, null, p)
}

/** The agent's command line; appId becomes --app so that helper requests reach the app they came from. */
fun agentCommand(tmuxSocket: String?, appId: String?): String {
    val env = if (tmuxSocket != null) "CSAGENT_TMUX_SOCKET=${shq(tmuxSocket)} " else ""
    val app = if (appId != null && APP_ID_RE.matches(appId)) " --app $appId" else ""
    return "export LANG=\"\${LANG:-C.UTF-8}\"; ${env}exec python3 -I ~/$REMOTE_DIR/csagent.py serve --protocol $PROTOCOL$app"
}

internal fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

internal fun newAppId(): String = ByteArray(8).also { SecureRandom().nextBytes(it) }.toHex()
