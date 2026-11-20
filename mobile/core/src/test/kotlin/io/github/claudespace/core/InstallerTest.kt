package io.github.claudespace.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// The same rules as tests/unit/installer.node.test.ts: the agent on the VM is shared by the PC and the phone.
class InstallerTest {
    private fun m(app: String?, hash: String, protocol: Int = 1) = Manifest("1", app, protocol, emptyMap(), hash)

    @Test
    fun `compareVersions compares release numbers, not strings`() {
        assertTrue(compareVersions("0.7.10", "0.7.9")!! > 0)
        assertTrue(compareVersions("0.8.0", "0.10.0")!! < 0)
        assertEquals(0, compareVersions("1.2.3", "1.2.3"))
        assertEquals(0, compareVersions("1.2.3-dev", "1.2.3"))
        assertNull(compareVersions(null, "0.7.10"))
        assertNull(compareVersions("0.7", "0.7.10"))
        assertNull(compareVersions("0.7.10", "latest"))
    }

    @Test
    fun installPlan() {
        val ours = m("0.8.0", "h-ours")
        assertEquals(InstallPlan.SAME, installPlan(m("0.7.0", "h-ours"), ours))
        assertEquals(InstallPlan.INSTALL, installPlan(null, ours))
        assertEquals(InstallPlan.INSTALL, installPlan(m("0.7.10", "h-old"), ours))
        assertEquals(InstallPlan.INSTALL, installPlan(m("0.8.0", "h-dev"), ours))
        assertEquals(InstallPlan.INSTALL, installPlan(m(null, "h-before-0.7.11"), ours))
        assertEquals(InstallPlan.KEEP_NEWER, installPlan(m("0.8.1", "h-new"), ours))
        assertEquals(InstallPlan.APP_TOO_OLD, installPlan(m("0.9.0", "h-new", 2), ours))
    }

    @Test
    fun `agentCommand passes the app id only when it is 16 hex digits`() {
        assertTrue(agentCommand(null, "0123456789abcdef").endsWith("serve --protocol 1 --app 0123456789abcdef"))
        assertFalse(agentCommand(null, "\$(id)").contains("--app"))
        assertTrue(agentCommand("test-sock", null).contains("CSAGENT_TMUX_SOCKET='test-sock' exec python3"))
        assertTrue(Regex("^[0-9a-f]{16}$").matches(newAppId()))
    }

    @Test
    fun `reads the bundled manifest`() {
        val m = Env.bundleManifest
        assertEquals(PROTOCOL, m.protocol)
        assertTrue("csagent.py" in m.files && m.files.keys.any { it.startsWith("cclib/") })
        assertEquals(java.io.File(Env.root, "package.json").readText().let {
            Regex("\"version\":\\s*\"([^\"]+)\"").find(it)!!.groupValues[1]
        }, m.app)
    }
}
