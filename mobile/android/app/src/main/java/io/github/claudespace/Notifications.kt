package io.github.claudespace

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.github.claudespace.core.ConnState
import io.github.claudespace.core.Notice

/** The app's two kinds of notification: the quiet one that keeps the service alive, and Claude's turns. */
object Notifications {
    const val CHANNEL_LINK = "link"
    const val CHANNEL_CLAUDE = "claude"
    const val ID_LINK = 1
    const val EXTRA_SESSION = "io.github.claudespace.session"
    const val EXTRA_CHAT = "io.github.claudespace.chat"

    fun createChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_LINK, "Связь с VM", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Значок, пока приложение держит связь с VM в фоне"
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_CLAUDE, "Claude", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Claude ждёт ввода или ответил"
            },
        )
    }

    private fun open(ctx: Context, session: String?, chatId: String?, request: Int): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            if (session != null) putExtra(EXTRA_SESSION, session)
            if (chatId != null) putExtra(EXTRA_CHAT, chatId)
        }
        return PendingIntent.getActivity(ctx, request, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun linkText(s: ConnState): String = when (s) {
        is ConnState.Online -> "На связи: ${s.host}"
        is ConnState.Connecting -> "Подключаюсь к VM…"
        is ConnState.Offline -> "Нет связи с VM, переподключаюсь"
        is ConnState.NeedsUser -> "Нужно ваше действие: откройте приложение"
        ConnState.Idle -> "Не подключено"
    }

    fun link(ctx: Context, text: String) = NotificationCompat.Builder(ctx, CHANNEL_LINK)
        .setSmallIcon(R.drawable.ic_stat_diamond)
        .setContentTitle("ClaudeSpace")
        .setContentText(text)
        .setOngoing(true)
        .setSilent(true)
        .setShowWhen(false)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setContentIntent(open(ctx, null, null, 0))
        .build()

    /** a turn of Claude; a newer one for the same chat replaces it. Returns what happened, for the journal. */
    fun turn(ctx: Context, n: Notice): String {
        val nm = NotificationManagerCompat.from(ctx)
        if (!nm.areNotificationsEnabled()) return "notifications are off for the app"
        val id = 1000 + ((n.session ?: n.chatId ?: "").hashCode() and 0xffff)
        val b = NotificationCompat.Builder(ctx, CHANNEL_CLAUDE)
            .setSmallIcon(R.drawable.ic_stat_diamond)
            .setContentTitle(n.title)
            .setContentText(n.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(n.body))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(open(ctx, n.session, n.chatId, id))
            .build()
        return try {
            nm.notify(id, b)
            "notification shown"
        } catch (e: SecurityException) {
            "no permission to notify: $e"
        }
    }
}
