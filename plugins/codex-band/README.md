# codex-band

A Claude Code mod that adds one line above the prompt: what Codex is doing right now, or when it last finished, plus a link to the shared [Codex requests](https://claude.ai/artifact/Dn5pxYxHT9N3joEr8Tbf5Y) page.

It reads the Codex plugin's own job records under `~/.claude/plugins/data/<codex plugin>/state/*/state.json` every 15 seconds, so it only shows live jobs on the computer where the Codex plugin runs (Andrew's desktop). In a cloud session it shows the link only. `Hide` hides the line for the session.

Install it from the repository root's README.
