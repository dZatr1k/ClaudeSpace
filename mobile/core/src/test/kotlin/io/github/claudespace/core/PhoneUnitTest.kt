package io.github.claudespace.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

// The phone core's pure parts: settings (the same rules as mergeMobileSettings in src/shared/mobile.ts), file names
// for attachments (tests/unit/attach.node.test.ts), and which turns become notifications.
class PhoneUnitTest {
    private fun patch(s: String) = Json.parseToJsonElement(s).jsonObject

    @Test
    fun `settings json has the shape of MobileSettings and defaults like the desktop's`() {
        assertEquals(
            """{"connection":{"host":"","port":22,"user":""},"appearance":{"theme":"dark","fontSize":12},"notifications":{"background":true}}""",
            PhoneSettings().toJson().toString(),
        )
    }

    @Test
    fun `settings merge drops wrong types and values out of range`() {
        val s = PhoneSettings().merge(patch("""{"connection":{"host":" vm ","port":2222,"user":" dev "}}"""))
        assertEquals(PhoneSettings(host = "vm", port = 2222, user = "dev"), s)
        assertTrue(s.configured)
        assertEquals(2222, s.merge(patch("""{"connection":{"port":0}}""")).port)
        assertEquals(2222, s.merge(patch("""{"connection":{"port":"22"}}""")).port)
        assertEquals(12, s.merge(patch("""{"appearance":{"fontSize":99}}""")).fontSize)
        assertEquals("dark", s.merge(patch("""{"appearance":{"theme":"neon"}}""")).theme)
        assertEquals(false, s.merge(patch("""{"notifications":{"background":false}}""")).background)
        assertEquals(true, s.merge(patch("""{"notifications":{"background":"no"}}""")).background)
        assertEquals(false, PhoneSettings(host = "vm").configured)
    }

    @Test
    fun `settings survive a save and a load, a broken file gives defaults`() {
        val dir = java.nio.file.Files.createTempDirectory("cs-set-").toFile()
        try {
            val f = java.io.File(dir, "settings.json")
            val s = PhoneSettings(host = "vm", user = "dev", theme = "light", fontSize = 14, background = false)
            s.save(f)
            assertEquals(s, PhoneSettings.load(f))
            f.writeText("{not json")
            assertEquals(PhoneSettings(), PhoneSettings.load(f))
            // a file from before the dark default (no "v"): «system» was the default then, it becomes dark
            f.writeText("""{"connection":{"host":"vm","user":"dev"},"appearance":{"theme":"system"}}""")
            assertEquals("dark", PhoneSettings.load(f).theme)
            // a choice saved since stays
            PhoneSettings(theme = "system").save(f)
            assertEquals("system", PhoneSettings.load(f).theme)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `imageExt by magic bytes`() {
        assertEquals("png", imageExt(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)))
        assertEquals("jpg", imageExt(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte())))
        assertEquals("gif", imageExt("GIF89a".toByteArray()))
        assertEquals("webp", imageExt("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ".toByteArray()))
        assertNull(imageExt("#!/bin/sh\nrm -rf /".toByteArray()))
        assertNull(imageExt(ByteArray(0)))
    }

    @Test
    fun `attachName keeps letters of any script, digits, the extension`() {
        assertEquals("report.pdf", attachName("report.pdf"))
        assertEquals("Резюме_2026_final.PDF", attachName("Резюме 2026 (final).PDF"))
        assertEquals("it_s_id_x.md", attachName("it's \$(id) `x`.md"))
        assertEquals("notes.txt", attachName("C:\\Users\\me\\notes.txt"))
        assertEquals("bashrc", attachName("../../.bashrc"))
        assertEquals("archive.tar.gz", attachName("archive.tar.gz"))
        assertEquals("Makefile", attachName("Makefile"))
        assertEquals("file.txt", attachName("???.txt"))
        assertEquals("file", attachName(""))
        assertEquals("a".repeat(80) + ".json", attachName("a".repeat(300) + ".json"))
        assertEquals("x.pdf", attachName("x.p d\$f"))
    }

    private fun turn(kind: String = "input", ts: Long = 1, body: String = "") =
        TurnDone(ts, kind, "c1", "Alpha", "/home/u/projects/Alpha/sub", "Alpha", body)

    @Test
    fun `a notification only while the app is hidden, each turn once, named after the chat's project`() {
        val n = TurnNotices()
        assertNull(n.notice(turn(ts = 1), appVisible = true, chatProject = null))
        assertNull(n.notice(turn(ts = 1), appVisible = false, chatProject = null), "the same turn twice")
        val x = assertNotNull(n.notice(turn(ts = 2), appVisible = false, chatProject = "/home/u/projects/Alpha"))
        assertEquals("Alpha: Claude ждёт ввода", x.title)
        assertEquals("Нужен ваш ответ или разрешение", x.body)
        assertEquals("Alpha" to "c1", x.session to x.chatId)
        val d = assertNotNull(n.notice(turn("done", 3, "Готово: сборка прошла"), false, null))
        assertEquals("sub: Claude ответил", d.title)
        assertEquals("Готово: сборка прошла", d.body)
    }

    @Test
    fun `TurnDone from the agent event`() {
        val t = assertNotNull(
            TurnDone.parse(
                Json.parseToJsonElement(
                    """{"ts":5,"kind":"done","chatId":"c","session":"S","cwd":"/x","project":null,"body":"b"}""",
                ),
            ),
        )
        assertEquals(TurnDone(5, "done", "c", "S", "/x", null, "b"), t)
        assertNull(TurnDone.parse(Json.parseToJsonElement("""{"ts":5,"kind":"other"}""")))
    }

    @Test
    fun `method timeouts as on the desktop`() {
        assertEquals(60_000, methodTimeout("usage"))
        assertEquals(30_000, methodTimeout("list_projects"))
        assertEquals(10_000, methodTimeout("list_chats"))
    }
}
