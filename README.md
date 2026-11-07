# codex-infoband-forclaude

A Claude Code mod, `codex-band`, that adds one line above the prompt showing what Codex is doing: the running review or task (kind, worktree, phase, minutes), or when the last one finished. It also links to the shared [Codex requests](https://claude.ai/artifact/Dn5pxYxHT9N3joEr8Tbf5Y) page, where each request, its findings and what was done about them are listed.

It reads the [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc)'s own job records under `~/.claude/plugins/data/<codex plugin>/state/*/state.json` every 15 seconds. So live status only shows on the computer where the Codex plugin runs. Elsewhere, such as a cloud session, the line shows just the link. `Hide` hides it for the session; `/codex-band` shows it again (`/codex-band hide` hides it).

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
