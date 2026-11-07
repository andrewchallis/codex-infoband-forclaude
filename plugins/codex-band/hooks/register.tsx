import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CodexJob, CodexSnapshot } from '../types'

// Shows above the prompt what Codex is doing, read from the Codex plugin's own
// job records (<home>/.claude/plugins/data/<codex plugin>/state/<workspace>/state.json),
// plus a link to the shared Codex requests page.
const PAGE = 'https://claude.ai/artifact/Dn5pxYxHT9N3joEr8Tbf5Y'
const EMPTY: CodexSnapshot = { found: false, jobs: [], checkedAt: 0 }
const snapshot = atom({ plugin: 'codex-band', key: 'snapshot' } as const, EMPTY, { shape: 'snapshot-1' })
const isHidden = atom({ plugin: 'codex-band', key: 'isHidden' } as const, false)

const active = (job: CodexJob) => job.status === 'queued' || job.status === 'running'

function minutesSince(iso: string | null, now: number) {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60000)) : null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
    const dataRoot = `${home.replace(/\\/g, '/')}/.claude/plugins/data`

    const scan = async () => {
      const jobs: CodexJob[] = []
      let found = false
      try {
        const plugins = (await $.fs.list(dataRoot)).filter(p => p.kind === 'dir' && /codex/i.test(p.name))
        for (const plugin of plugins) {
          const stateRoot = `${dataRoot}/${plugin.name}/state`
          if (!(await $.fs.exists(stateRoot))) continue
          found = true
          for (const ws of await $.fs.list(stateRoot)) {
            const file = `${stateRoot}/${ws.name}/state.json`
            if (ws.kind !== 'dir' || !(await $.fs.exists(file))) continue
            try {
              const parsed = JSON.parse(await $.fs.read(file))
              for (const j of Array.isArray(parsed.jobs) ? parsed.jobs : []) {
                jobs.push({
                  id: String(j.id ?? ''),
                  kind: String(j.kindLabel ?? j.jobClass ?? 'job'),
                  title: String(j.summary ?? j.title ?? 'Codex job').slice(0, 90),
                  status: String(j.status ?? 'unknown'),
                  phase: typeof j.phase === 'string' ? j.phase : null,
                  startedAt: j.startedAt ?? j.createdAt ?? null,
                  updatedAt: j.updatedAt ?? j.completedAt ?? null,
                  workspace: ws.name.replace(/-[0-9a-f]{16}$/, ''),
                })
              }
            } catch { /* a state file mid-write: next scan */ }
          }
        }
      } catch { /* no plugin data here (e.g. a cloud session) */ }
      jobs.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      await update($, snapshot, () => ({ found, jobs: jobs.slice(0, 20), checkedAt: Date.now() }))
    }

    await scan()
    $.clock.every(15000, () => { void scan() })
    await $.command.register({ name: 'codex-band', description: 'Show the Codex band again after Hide (args: show | hide)' })

    return next(e)
  })

  on('command.run', { command: 'codex-band' }, async ($, e) => {
    const hide = e.args.trim() === 'hide'
    await update($, isHidden, () => hide)
    return { text: hide ? 'Codex band hidden.' : 'Codex band shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const snap = await read($, snapshot)
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const now = Date.now()
    const running = snap.jobs.filter(active)
    const last = snap.jobs.find(j => !active(j))

    let line: string
    const j = running[0]
    if (j) {
      const mins = minutesSince(j.startedAt, now)
      line = `Codex ${j.kind} running in ${j.workspace}${j.phase ? `: ${j.phase}` : ''}${mins !== null ? `, ${mins} min` : ''}`
      if (running.length > 1) line += ` (+${running.length - 1} more)`
    } else if (last) {
      const mins = minutesSince(last.updatedAt, now)
      const ago = mins === null ? '' : mins < 90 ? ` ${mins} min ago` : ` ${Math.round(mins / 60)} h ago`
      line = `Codex idle. Last ${last.kind} in ${last.workspace} ${last.status}${ago}`
    } else {
      line = snap.found ? 'Codex idle. No jobs yet' : 'Codex runs on the desktop'
    }

    return (
      <Box borderStyle="round" borderDimColor paddingX={1}>
        <Text color={running.length ? 'yellow' : undefined} dimColor={!running.length}>{line} · </Text>
        <Link href={PAGE} label="Codex requests" />
        <Text> </Text>
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
