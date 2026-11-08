import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CodexJob, CodexSnapshot, LoggedRows } from '../types'

// Shows above the prompt what Codex is doing, read from the Codex plugin's own
// job records (<home>/.claude/plugins/data/<codex plugin>/state/<workspace>/state.json),
// plus a link to the shared Codex requests page. Hidden until the session involves
// Codex: a Codex tool call or command, or a Codex job this session started.
// Each Codex job this session starts is also logged on that page.
const PAGE = 'https://claude.ai/artifact/Dn5pxYxHT9N3joEr8Tbf5Y'
const COLLECTION = 'requests'
const EMPTY: CodexSnapshot = { found: false, jobs: [], checkedAt: 0 }
const snapshot = atom({ plugin: 'codex-band', key: 'snapshot' } as const, EMPTY, { shape: 'snapshot-4' })
const isHidden = atom({ plugin: 'codex-band', key: 'isHidden' } as const, false)
const isShown = atom({ plugin: 'codex-band', key: 'isShown' } as const, false)
const isPulseOn = atom({ plugin: 'codex-band', key: 'isPulseOn' } as const, false)
const logged = atom({ plugin: 'codex-band', key: 'logged' } as const, {} as LoggedRows, { shape: 'logged-1' })
const lastCommand = atom({ plugin: 'codex-band', key: 'lastCommand' } as const, '')
// The job whose Stop was pressed once and waits for the confirming press, with when.
const stopArmed = atom({ plugin: 'codex-band', key: 'stopArmed' } as const, { id: '', at: 0 })
const ARM_MS = 10000
let rescan: () => Promise<void> = async () => {}

// A job the Codex plugin never closed (its process died) stays 'running' forever.
const STALE_MS = 2 * 60 * 60 * 1000
const active = (job: CodexJob) => job.status === 'queued' || job.status === 'running'

// The Codex plugin's companion script, the codex CLI, Codex skills and the Codex subagent.
const CODEX_SHELL = /codex-companion|\bcodex(\.exe)?\s+(exec|review|resume|apply)\b/i
const CODEX_NAME = /(^|:)codex(?!-band\b)|astra-review/i

function field(e: object, k: string) {
  const v = (e as Record<string, unknown>)[k]
  return typeof v === 'string' ? v : ''
}

function isCodexCall(e: object) {
  const tool = field(e, 'tool')
  if (tool === 'Bash' || tool === 'PowerShell') return CODEX_SHELL.test(field(e, 'command'))
  if (tool === 'Skill') return CODEX_NAME.test(field(e, 'skill'))
  if (tool === 'Agent') return /codex/i.test(field(e, 'subagent_type'))
  return false
}

// Only this mod's own writes to the requests list are pre-approved.
function isOwnPageWrite(input: unknown) {
  const i = (input ?? {}) as Record<string, unknown>
  return i.url === PAGE && i.collection === COLLECTION && ['get', 'set', 'update'].includes(String(i.action))
}

// Opens the page in the person's browser, so Requests can be a real Button beside Stop and Hide.
async function openPage($: EngineInterface) {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows ? ['rundll32', 'url.dll,FileProtocolHandler', PAGE] : ['open', PAGE]
  try {
    const r = await $.process.run(argv)
    if (r.exitCode === 0 || isWindows) return
    await $.process.run(['xdg-open', PAGE])
  } catch {
    $.ui.toast(`Couldn't open the page: ${PAGE}`)
  }
}

// The Codex plugin's own cancel: interrupts the Codex turn, ends its process and marks the job cancelled.
async function stopJob($: EngineInterface, job: CodexJob) {
  const home = ((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '').replace(/\\/g, '/')
  const cache = `${home}/.claude/plugins/cache`
  let script = ''
  try {
    for (const market of (await $.fs.list(cache)).filter(d => d.kind === 'dir' && /codex/i.test(d.name))) {
      const root = `${cache}/${market.name}/codex`
      if (!(await $.fs.exists(root))) continue
      const versions = (await $.fs.list(root)).filter(d => d.kind === 'dir').map(d => d.name).sort()
      for (const v of versions.reverse()) {
        const candidate = `${root}/${v}/scripts/codex-companion.mjs`
        if (await $.fs.exists(candidate)) { script = candidate; break }
      }
      if (script) break
    }
  } catch { /* no plugin cache: reported below */ }
  if (!script || !job.workspaceRoot) {
    $.ui.toast("Couldn't find the Codex plugin to stop this job. Try /codex:cancel in its thread.")
    return
  }
  try {
    const r = await $.process.run(['node', script, 'cancel', job.id, '--cwd', job.workspaceRoot, '--json'], { cwd: job.workspaceRoot })
    $.ui.toast(r.exitCode === 0 ? `Stopped Codex ${job.kind} in ${job.workspace}.` : `Codex didn't stop: ${(r.stderr || r.stdout).trim().slice(0, 200)}`)
  } catch (err) {
    $.ui.toast(`Codex didn't stop: ${String(err).slice(0, 200)}`)
  }
  await rescan()
}

async function setShown($: EngineInterface, on: boolean) {
  await update($, isHidden, () => !on)
  await update($, isShown, () => on)
}

function minutesSince(iso: string | null, now: number) {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60000)) : null
}

// The page's own status words: queued, running, finished, failed, cancelled.
const pageStatus = (s: string) => (s === 'completed' ? 'finished' : s)

function pageRow(job: CodexJob, command: string) {
  const row: Record<string, unknown> = {
    kind: job.kind,
    title: `${job.kind} in ${job.workspace}`,
    status: pageStatus(job.status),
    sentAt: job.createdAt ?? job.startedAt,
    thread: job.workspace,
  }
  if (command) row.brief = command
  if (job.completedAt) row.finishedAt = job.completedAt
  if (job.status === 'completed' && job.summary) row.summary = job.summary
  return row
}

type Call = { deny?: string; isError?: boolean; text?: string }
const versionOf = (r: Call) => Number(/version\D{0,3}(\d+)/i.exec(r.text ?? '')?.[1] ?? NaN)
const failed = (r: Call) => Boolean(r.deny || r.isError)

async function logJob($: EngineInterface, job: CodexJob, command: string, known: LoggedRows[string] | undefined) {
  const base = { tool: 'ArtifactData', url: PAGE, collection: COLLECTION, doc_id: job.id }
  const data = pageRow(job, known ? '' : command)
  let r: Call = known
    ? await $.tool.call({ ...base, action: 'update', data, if_version: known.version })
    : await $.tool.call({ ...base, action: 'set', data })
  if (failed(r)) {
    // The row exists (a resumed session) or changed since (a thread added findings): re-read, then merge.
    const got: Call = await $.tool.call({ ...base, action: 'get' })
    const v = versionOf(got)
    if (failed(got) || !Number.isFinite(v)) return null
    r = await $.tool.call({ ...base, action: 'update', data, if_version: v })
    if (failed(r)) return null
  }
  const v = versionOf(r)
  return Number.isFinite(v) ? v : (known?.version ?? 1) + 1
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
    const dataRoot = `${home.replace(/\\/g, '/')}/.claude/plugins/data`
    let isSyncing = false

    const sync = async (jobs: CodexJob[]) => {
      if (isSyncing) return
      isSyncing = true
      try {
        const me = await $.session.id()
        const rows = await read($, logged)
        const command = await read($, lastCommand)
        for (const job of jobs.filter(j => j.sessionId === me)) {
          const known = rows[job.id]
          if (known?.status === job.status) continue
          const version = await logJob($, job, command, known)
          if (version !== null) await update($, logged, all => ({ ...all, [job.id]: { status: job.status, version } }))
        }
      } catch { /* the page is out of reach (offline, signed out): next scan */ }
      isSyncing = false
    }

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
                const updatedAt = j.updatedAt ?? j.completedAt ?? null
                let status = String(j.status ?? 'unknown')
                const seen = Date.parse(updatedAt ?? j.startedAt ?? '')
                if ((status === 'queued' || status === 'running') && !(Date.now() - seen < STALE_MS)) status = 'stalled'
                jobs.push({
                  id: String(j.id ?? ''),
                  kind: String(j.kindLabel ?? j.jobClass ?? 'job'),
                  summary: typeof j.summary === 'string' ? j.summary.slice(0, 600) : null,
                  status,
                  phase: typeof j.phase === 'string' ? j.phase : null,
                  createdAt: j.createdAt ?? null,
                  startedAt: j.startedAt ?? j.createdAt ?? null,
                  updatedAt,
                  completedAt: j.completedAt ?? null,
                  workspace: ws.name.replace(/-[0-9a-f]{16}$/, ''),
                  workspaceRoot: typeof j.workspaceRoot === 'string' ? j.workspaceRoot : null,
                  sessionId: typeof j.sessionId === 'string' ? j.sessionId : null,
                })
              }
            } catch { /* a state file mid-write: next scan */ }
          }
        }
      } catch { /* no plugin data here (e.g. a cloud session) */ }
      jobs.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      await update($, snapshot, () => ({ found, jobs: jobs.slice(0, 20), checkedAt: Date.now() }))
      void sync(jobs)
      const armed = await read($, stopArmed)
      if (armed.id && Date.now() - armed.at > ARM_MS) await update($, stopArmed, () => ({ id: '', at: 0 }))
    }
    rescan = scan

    await scan()
    $.clock.every(15000, () => { void scan() })
    // The activity light: flips only while a job runs, so an idle band never redraws.
    $.clock.every(800, async () => {
      const running = (await read($, snapshot)).jobs.some(active)
      if (running || (await read($, isPulseOn))) await update($, isPulseOn, lit => running && !lit)
    })
    await $.command.register({ name: 'codex-band', description: 'Show the Codex band (args: show | hide)' })

    return next(e)
  })

  // Shown before the call runs, so it is up while a Codex hand-off waits for permission.
  on('tool.call', async ($, e, next) => {
    if (isCodexCall(e)) {
      await setShown($, true)
      const command = field(e, 'command') || field(e, 'skill') || field(e, 'prompt') || field(e, 'subagent_type')
      await update($, lastCommand, () => command.slice(0, 2000))
    }
    return next(e)
  })

  on('tool.check', { tool: 'ArtifactData' }, ($, e, next) =>
    next.origin.plugin === $.plugin.name && isOwnPageWrite(e.input) ? { decision: 'allow' } : next(e),
  )

  on('command.run', async ($, e, next) => {
    if (e.command === 'codex-band') {
      const hide = e.args.trim() === 'hide'
      await setShown($, !hide)
      return { text: hide ? 'Codex band hidden.' : 'Codex band shown.' }
    }
    if (CODEX_NAME.test(e.command)) await setShown($, true)
    return next(e)
  })

  // Tells the model where its Codex job's row is, so findings go there and not in a second row.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const me = await $.session.id()
    const mine = (await read($, snapshot)).jobs.filter(j => j.sessionId === me)
    if (!mine.length) return composed
    const text = `Codex requests page (${PAGE}): codex-band logs each Codex job of this session in its "${COLLECTION}" collection, doc id = the Codex job id (${mine.map(j => j.id).slice(0, 5).join(', ')}). When you act on a job's findings, add them to that row with ArtifactData update: findings [{ priority, title, state: pending|fixed|rejected|later, action }], and pr, commit or summary where known. Never create a second row for the same job.`
    return { ...composed, sections: [...composed.sections, { id: 'codex-band-requests', text, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const snap = await read($, snapshot)
    const me = await $.session.id()
    if (!(await read($, isShown)) && !snap.jobs.some(j => j.sessionId === me)) return next(e)

    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const now = Date.now()
    // This session's own running job first: it is the one the line names and Stop stops.
    const running = snap.jobs.filter(active).sort((a, b) => Number(b.sessionId === me) - Number(a.sessionId === me))
    const last = snap.jobs.find(j => !active(j))
    const isPulsing = running.length > 0 && (await read($, isPulseOn))

    let line: string
    const j = running[0]
    if (j) {
      const mins = minutesSince(j.startedAt, now)
      line = `Codex ${j.kind} running in ${j.workspace}${j.phase ? `: ${j.phase}` : ''}${mins !== null ? `, ${mins} min` : ''}`
      if (running.length > 1) line += ` (+${running.length - 1} more)`
    } else if (last) {
      const mins = minutesSince(last.updatedAt, now)
      const ago = mins === null ? '' : mins < 90 ? ` ${mins} min ago` : mins < 2880 ? ` ${Math.round(mins / 60)} h ago` : ` ${Math.round(mins / 1440)} d ago`
      line = `Codex idle. Last ${last.kind} in ${last.workspace} ${last.status}${ago}`
    } else {
      line = snap.found ? 'Codex idle. No jobs yet' : 'Codex runs on the desktop'
    }

    const armed = await read($, stopArmed)
    const isArmed = Boolean(j) && armed.id === j?.id && now - armed.at < ARM_MS
    const onStop = async () => {
      if (!j) return
      if (!isArmed) return update($, stopArmed, () => ({ id: j.id, at: Date.now() }))
      await update($, stopArmed, () => ({ id: '', at: 0 }))
      await stopJob($, j)
    }

    // Mobile draws on another device than the host, so there the page stays a link.
    const requests = e.surface === 'mobile'
      ? <Link href={PAGE} label="Requests" />
      : <Button key="requests" label="Requests" onPress={() => openPage($)} />
    const isTerminal = e.surface === 'terminal'

    return (
      <Box flexDirection="column" borderStyle={isTerminal ? 'round' : undefined} borderDimColor paddingX={isTerminal ? 1 : 0}>
        <Box justifyContent="flex-end" gap={1}>
          {requests}
          {j ? <Button key="stop" label={isArmed ? 'Confirm stop' : 'Stop'} onPress={onStop} /> : null}
          <Button key="hide" label="Hide" onPress={() => setShown($, false)} />
        </Box>
        <Box>
          <Text color={running.length ? (isPulsing ? 'greenBright' : 'green') : 'gray'} dimColor={!running.length || !isPulsing}>● </Text>
          <Text color={running.length ? 'yellow' : undefined} dimColor={!running.length}>{line}</Text>
        </Box>
      </Box>
    )
  })
}
