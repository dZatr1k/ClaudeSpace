# Changelog

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
