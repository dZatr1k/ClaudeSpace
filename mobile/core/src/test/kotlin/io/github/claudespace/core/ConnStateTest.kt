package io.github.claudespace.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// The UI is shared with the PC: states serialize to ConnState of src/shared/model.ts.
class ConnStateTest {
    @Test
    fun `json has the shape of the desktop ConnState`() {
        assertEquals("""{"kind":"idle"}""", ConnState.Idle.toJson().toString())
        assertEquals(
            """{"kind":"connecting","step":"agent","attempt":2,"detail":"Установка"}""",
            ConnState.Connecting(ConnState.Step.AGENT, 2, "Установка").toJson().toString(),
        )
        assertEquals(
            """{"kind":"needs-user","reason":"hostkey-new","fingerprint":"SHA256:x","host":"vm:2222"}""",
            ConnState.NeedsUser(ConnState.Reason.HOSTKEY_NEW, fingerprint = "SHA256:x", host = "vm:2222").toJson().toString(),
        )
        assertEquals(
            """{"kind":"online","since":1,"rttMs":null,"agent":"0.1.0","host":"u@vm"}""",
            ConnState.Online(1, null, "0.1.0", "u@vm").toJson().toString(),
        )
        assertEquals(
            """{"kind":"offline","since":1,"retryAt":2,"attempt":3,"error":"x"}""",
            ConnState.Offline(1, 2, 3, "x").toJson().toString(),
        )
    }

    @Test
    fun `backoff 1-2-4-8-16-30 s within 20 percent`() {
        assertEquals(800, backoffDelay(0) { 0.0 })
        assertEquals(1200, backoffDelay(0) { 1.0 })
        assertEquals(30_000, backoffDelay(5) { 0.5 })
        assertEquals(30_000, backoffDelay(99) { 0.5 })
        for (i in 0..20) assertTrue(backoffDelay(3) in 6400..9600)
    }
}
