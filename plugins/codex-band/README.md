# codex-band

A Claude Code mod that adds one line above the prompt: what Codex is doing right now, or when it last finished, plus a link to the shared [Codex requests](https://claude.ai/artifact/Dn5pxYxHT9N3joEr8Tbf5Y) page.

It reads the Codex plugin's own job records under `~/.claude/plugins/data/<codex plugin>/state/*/state.json` every 15 seconds, so it only shows live jobs on the computer where the Codex plugin runs (Andrew's desktop). In a cloud session it shows the link only. It stays hidden in a new chat until the session involves Codex: a Codex hand-off (the companion script, a Codex skill or the Codex subagent, shown while it waits for permission), a `/codex:*` command, or a Codex job this session started. `Hide` hides it until Codex comes up again; `/codex-band` shows it, `/codex-band hide` hides it. Each Codex job a session starts gets a row on the Codex requests page (doc id = the Codex job id), written by the mod and updated as the job runs and finishes; the mod approves only its own writes to that page's `requests` list. The thread adds the findings and what was done to that row. A light at the left pulses while a job runs.

Install it from the repository root's README.
