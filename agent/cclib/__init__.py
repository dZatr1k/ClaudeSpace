"""cclib — data layer for Claude Code on this VM (stdlib only).

Shared by csagent (ClaudeSpace) and, later, cc-menu. No terminal formatting here.
Never reads credentials, settings.local.json, history.jsonl, sessions/*.key or ~/.ssh (see paths.py).
"""
