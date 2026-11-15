# Changelog

## Unreleased
- The tmux status line (session name, clock, host) is hidden in the app's terminals: tmux gets one more row than
  the window shows and that row is cut off, so SSH and phone clients keep their status line. Settings →
  Terminal → «Прятать строку tmux» turns it back on.
- Split view: each pane has a thin header with the project name, the chat title and its state.

## 0.7.2
- WebGL terminal renderer draws glyphs at full size. The cause of the small letters: Electron's canvas rejects a
  font value that starts with a space and falls back to 10px, and xterm builds its glyph font that way. The app
  now trims the value. The self-check measures glyph height on the real terminal too and still switches to DOM
  if something goes wrong.

## 0.7.1
- Claude bar: text you had started typing no longer gets the command appended to it. The app puts the draft
  aside with Claude Code's own stash (Ctrl+S), and Claude Code brings it back once the command has run.
- Syntax highlighting in the file viewer for common languages (TypeScript, Python, C#, shell, JSON, YAML and
  more), also in fenced code blocks of markdown documents.
- Git tab: a commit opens with its message, changed files and patch.
- The Claude settings and usage screens have labelled buttons in the title bar («Настройки Claude», «Расход»).

## 0.7.0
- Several chats on screen: the layout button in the title bar shows one tab, two side by side, two stacked or
  four. Clicking a tab puts it into the focused pane; Ctrl+Alt+← / → moves between panes. The layout is restored
  on the next start.
- Usage (System → Расход): the current 5-hour window as tiles (tokens, time to reset, pace, projection) and
  charts for 7, 14 or 30 days by day, project and model.
- WebGL terminal renderer checks itself: if glyphs come out much narrower than they should (a GPU issue seen on
  Windows), the terminal switches to the DOM renderer and says so.

## 0.6.1
- Same features as 0.6.0, which was not published: its build stopped on a failing test.
- Removing a task checks every tmux pane for work inside its folder, not only the active one.

## 0.6.0
- Files tab: the folder of the current chat, project or session as a tree with git marks; a viewer for text,
  markdown and images; paste a path into the chat, download to the PC, open in VS Code; drop files from the PC
  onto a folder to upload them.
- Git tab: branch and upstream, changed files by group, recent commits, a diff viewer; changes are made in lazygit.
- Claude bar under the terminal: the chat's status, Interrupt (Esc), Compact (/compact), Clear (/clear, asks
  first) and a model menu (/model). Commands are typed into the pane where that Claude runs and only while it is
  idle, so a click never answers a permission prompt. The same actions are in the Ctrl+K palette.
- Claude settings screen (the Claude button in the title bar): edit CLAUDE.md files and memory notes, see MCP
  servers, skills, plugins and hooks. MCP keys and full server commands stay on the VM. A save never overwrites
  a file that changed on the VM while you were editing it.
- Tasks in separate folders: Git tab → New task creates a branch in its own git worktree
  (`.claude/worktrees/<name>` inside the repo) and opens a new chat there, so a second Claude works without
  touching the main checkout. The Git tab lists the tasks with their changes and removes finished ones (only
  clean ones, or after a warning; the branch is deleted only if it is merged).
- Two ClaudeSpace copies on one VM (say, a dev build and the installed app) no longer unmount each other's PC disk
  on exit.

## 0.5.0
- Images in chats: paste a screenshot with Ctrl+V or drop image files onto a terminal. The image is uploaded
  to the VM (`~/.cache/claudespace/images`, kept for a week) and its path is pasted, so Claude Code attaches it.
- The empty space after the tabs moves the window.

## 0.4.0
- Startup splash: the app shows the connection stages (settings, login, agent) while it connects to the VM
  instead of an empty window saying "no connection"; retry or open offline if the VM does not answer.

## 0.3.0
- UI redesign: warm graphite palette with an orange accent, new start screen, unified connection and
  terminal state cards, clearer copy, better contrast in both themes (ANSI colors included).

## 0.2.3
- First release delivered by auto-update; changelog added.

## 0.2.2
- Fix auto-update: the packaged app could not load electron-updater, so checks never ran.
- Each tag now produces a single GitHub release.

## 0.2.1
- Much quieter SSH debug log (no per-packet lines); updater status changes are logged.

## 0.2.0
- First public release: Windows installer, auto-update from GitHub Releases, tray, autostart,
  in-app sudo password prompt, chat full-text search, PC link (reverse tunnel + PC disk), port forwarding.
