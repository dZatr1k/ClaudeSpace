package io.github.claudespace.core

/** POSIX single-quote for the remote shell. */
fun shq(s: String): String = "'" + s.replace("'", "'\\''") + "'"

/** this app's id on the VM for one connection: the agent gets it as --app, terminals as CLAUDESPACE_APP */
val APP_ID_RE = Regex("^[0-9a-f]{16}$")

/** tmux session names the agent creates and accepts (src/shared/protocol.ts) */
val SESSION_RE = Regex("^[A-Za-z0-9_-]{1,32}$")

/** the agent protocol this core speaks (src/shared/protocol.ts PROTOCOL) */
const val PROTOCOL = 1
