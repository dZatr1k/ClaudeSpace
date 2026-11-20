package io.github.claudespace

import android.content.res.AssetManager
import io.github.claudespace.core.AgentBundle

/** The agent bundle packed into the APK (assets/agent, built by agentAssets in app/build.gradle). */
class AssetBundle(private val assets: AssetManager, private val dir: String = "agent") : AgentBundle {
    override val manifestText: String
        get() = assets.open("$dir/MANIFEST.json").use { it.readBytes().decodeToString() }

    override fun read(rel: String): ByteArray = assets.open("$dir/$rel").use { it.readBytes() }
}
