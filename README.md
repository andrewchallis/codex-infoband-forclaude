# codex-infoband-forclaude

A Claude Code mod, `codex-band`, that adds one line above the prompt showing what Codex is doing: the running review or task (kind, worktree, phase, minutes), or when the last one finished. It also links to the shared [Codex requests](https://claude.ai/artifact/Dn5pxYxHT9N3joEr8Tbf5Y) page, where each request, its findings and what was done about them are listed.

It reads the [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc)'s own job records under `~/.claude/plugins/data/<codex plugin>/state/*/state.json` every 15 seconds. So live status only shows on the computer where the Codex plugin runs. Elsewhere, such as a cloud session, the line shows just the link. It stays hidden in a new chat until the session involves Codex: a Codex hand-off (the companion script, a Codex skill or the Codex subagent, shown while it waits for permission), a `/codex:*` command, or a Codex job this session started. `Hide` hides it until Codex comes up again; `/codex-band` shows it, `/codex-band hide` hides it. Each Codex job a session starts gets a row on the Codex requests page (doc id = the Codex job id), written by the mod and updated as the job runs and finishes; the mod approves only its own writes to that page's `requests` list. The thread adds the findings and what was done to that row. A light at the left pulses while a job runs. A row of buttons sits above the status: Requests opens the page in the browser, Stop (dim while nothing runs; press twice) cancels that job through the Codex plugin's own cancel, and Hide.

## Install

```
claude plugin marketplace add andrewchallis/codex-infoband-forclaude
claude plugin install codex-band@codex-infoband-forclaude
```

Then run `/reload-plugins` in any open session. To get a newer version later: `claude plugin marketplace update codex-infoband-forclaude`, `claude plugin update codex-band@codex-infoband-forclaude`, then `/reload-plugins`.

If you installed it from the universe-lab repository before, remove that copy first:

```
claude plugin uninstall codex-band@universe-lab
claude plugin marketplace remove universe-lab
```

## Layout

- `.claude-plugin/marketplace.json`: the marketplace, one plugin.
- `plugins/codex-band/`: the mod (`hooks/register.tsx`, its state types in `types/index.d.ts`).
