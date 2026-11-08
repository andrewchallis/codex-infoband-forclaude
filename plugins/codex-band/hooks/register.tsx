import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CodexJob, CodexSnapshot, LoggedRows } from '../types'

// Shows above the prompt what Codex is doing, read from the Codex plugin's own
// job records (<home>/.claude/plugins/data/<codex plugin>/state/<workspace>/state.json),
// plus a link to the person's Codex requests page. Hidden until the session involves
// Codex: a Codex tool call or command, or a Codex job this session started.
// Each Codex job this session starts is also logged on that page, which the mod finds
// or creates the first time it has a job to log.
const PAGE_TITLE = 'Codex Band Requests'
const PAGE_RULES = { db: { rules: [{ path: 'requests', read: 'view', write: 'owner' }, { path: 'settings', read: 'view', write: 'owner' }] } }
const PAGE_CONTRACT = '0.2.96'
const STORE_URL = 'pageUrl'
const STORE_LOCK = 'pageCreatingAt'
// The page's "hide the bar after Codex is idle for" setting, in minutes (0: never), cached across sessions.
const STORE_HIDE = 'autoHideMinutes'
const DEFAULT_HIDE_MINUTES = 10
const SETTINGS_EVERY_MS = 10 * 60 * 1000
const LOCK_MS = 10 * 60 * 1000
const COLLECTION = 'requests'
const EMPTY: CodexSnapshot = { found: false, isFromPage: false, jobs: [], checkedAt: 0 }
// Where no Codex job files exist (a cloud session), the band shows the page's rows instead, read this often.
const PAGE_READ_EVERY_MS = 30000
let lastPageReadAt = 0
let pageJobs: CodexJob[] = []
const snapshot = atom({ plugin: 'codex-band', key: 'snapshot' } as const, EMPTY, { shape: 'snapshot-5' })
const isHidden = atom({ plugin: 'codex-band', key: 'isHidden' } as const, false)
const isShown = atom({ plugin: 'codex-band', key: 'isShown' } as const, false)
// When something last brought the band up, so a band shown for a hand-off isn't hidden at once.
const shownAt = atom({ plugin: 'codex-band', key: 'shownAt' } as const, 0)
const isPulseOn = atom({ plugin: 'codex-band', key: 'isPulseOn' } as const, false)
const logged = atom({ plugin: 'codex-band', key: 'logged' } as const, {} as LoggedRows, { shape: 'logged-1' })
const lastCommand = atom({ plugin: 'codex-band', key: 'lastCommand' } as const, '')
// The job whose Stop was pressed once and waits for the confirming press, with when.
const stopArmed = atom({ plugin: 'codex-band', key: 'stopArmed' } as const, { id: '', at: 0 })
const ARM_MS = 10000
let rescan: () => Promise<void> = async () => {}
// One find-or-create attempt per session, so a declined prompt is not asked again every scan.
let hasTriedPage = false

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
  if (tool === 'SendMessage') return /\/codex:/i.test(field(e, 'message'))
  return false
}

async function storedPage($: EngineInterface) {
  const url = await $.store.get(STORE_URL)
  return typeof url === 'string' && url ? url : null
}

// Pre-approved: this mod's own reads and writes to its page's requests list, and its own artifact listing.
// Creating the page is left to the usual permission prompt.
export function isOwnPageCall(tool: string, input: unknown, url: string | null) {
  const i = (input ?? {}) as Record<string, unknown>
  if (tool === 'Artifact') return i.action === 'list' && !i.url
  if (i.collection === 'settings') return Boolean(url) && i.url === url && i.action === 'get' && i.doc_id === 'page'
  return Boolean(url) && i.url === url && i.collection === COLLECTION && ['get', 'list', 'set', 'update'].includes(String(i.action))
}

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/

// The page's address: remembered, else a page of the person's with this mod's title, else a new one.
export async function ensurePage($: EngineInterface, mayCreate = true) {
  const known = await storedPage($)
  if (known || hasTriedPage) return known
  hasTriedPage = true
  const lockedAt = Number(await $.store.get(STORE_LOCK)) || 0
  if (Date.now() - lockedAt < LOCK_MS) return null // another session is creating it
  try {
    const listed: Call = await $.tool.call({ tool: 'Artifact', action: 'list', scope: 'mine', limit: 200 })
    const line = (listed.text ?? '').split('\n').find(l => l.includes(` ${PAGE_TITLE} — `))
    let url = line ? ARTIFACT_URL.exec(line)?.[0] ?? null : null
    if (!url && !mayCreate) hasTriedPage = false
    if (!url && mayCreate) {
      await $.store.set(STORE_LOCK, Date.now())
      const made: Call = await $.tool.call({
        tool: 'Artifact', action: 'publish', file_path: `${$.plugin.root}/page/index.html`, title: PAGE_TITLE,
        icon: 'list', description: 'Every Codex review or task a Claude session sends, its findings and what was done about them.',
        capabilities: PAGE_RULES, contract: PAGE_CONTRACT,
      })
      await $.store.delete(STORE_LOCK)
      url = failed(made) ? null : ARTIFACT_URL.exec(made.text ?? '')?.[0] ?? null
      if (url) $.ui.toast(`Created your ${PAGE_TITLE} page.`)
    }
    if (url) await $.store.set(STORE_URL, url)
    return url
  } catch {
    return null // no Artifact tool here (not signed in to claude.ai), or the call was refused
  }
}

// Opens the page in the person's browser, so Requests can be a real Button beside Stop and Hide.
async function openPage($: EngineInterface) {
  const url = await storedPage($)
  if (!url) return $.ui.toast(`Your ${PAGE_TITLE} page is created with this session's first Codex job.`)
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['open', url]
  try {
    const r = await $.process.run(argv)
    if (r.exitCode === 0 || isWindows) return
    await $.process.run(['xdg-open', url])
  } catch {
    $.ui.toast(`Couldn't open the page: ${url}`)
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

// The page's status words back to the Codex plugin's: finished is completed.
const jobStatus = (s: string) => (s === 'finished' ? 'completed' : s)

// The page's rows as jobs, for a machine with no Codex job files: one JSON record per line of the read.
export function jobsFromPage(text: string, now: number): CodexJob[] {
  const jobs: CodexJob[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const { id, data } = JSON.parse(line) as { id: string; data: Record<string, unknown> }
      const str = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : null)
      const sentAt = str('sentAt')
      const updatedAt = str('finishedAt') ?? sentAt
      let status = jobStatus(str('status') ?? 'unknown')
      if ((status === 'queued' || status === 'running') && !(now - Date.parse(updatedAt ?? '') < STALE_MS)) status = 'stalled'
      jobs.push({
        id, kind: str('kind') ?? 'job', summary: str('summary'), status, phase: null,
        createdAt: sentAt, startedAt: sentAt, updatedAt, completedAt: str('finishedAt'),
        workspace: str('thread') ?? str('title') ?? 'Codex', workspaceRoot: null, sessionId: null,
      })
    } catch { /* not a record line */ }
  }
  return jobs
}

async function readPageJobs($: EngineInterface) {
  if (Date.now() - lastPageReadAt < PAGE_READ_EVERY_MS) return pageJobs
  lastPageReadAt = Date.now()
  const url = await ensurePage($, false)
  if (!url) return pageJobs
  try {
    const listed: Call = await $.tool.call({ tool: 'ArtifactData', action: 'list', url, collection: COLLECTION, query: { limit: 100 } })
    if (!failed(listed)) pageJobs = jobsFromPage(listed.text ?? '', Date.now())
  } catch { /* the page is out of reach: keep the last read */ }
  return pageJobs
}

async function setShown($: EngineInterface, on: boolean) {
  await update($, isHidden, () => !on)
  await update($, isShown, () => on)
  if (on) await update($, shownAt, () => Date.now())
}

async function hideMinutes($: EngineInterface) {
  const v = await $.store.get(STORE_HIDE)
  return typeof v === 'number' && v >= 0 ? v : DEFAULT_HIDE_MINUTES
}

// Reads the page's settings document; a page with none saved keeps the default.
async function refreshSettings($: EngineInterface) {
  const url = await storedPage($)
  if (!url) return
  try {
    const got: Call = await $.tool.call({ tool: 'ArtifactData', action: 'get', url, collection: 'settings', doc_id: 'page' })
    if (failed(got)) return
    const m = /"autoHideMinutes"\s*:\s*(\d+)/.exec(got.text ?? '')
    const minutes = m ? Math.min(1440, Number(m[1])) : DEFAULT_HIDE_MINUTES
    await $.store.set(STORE_HIDE, minutes)
  } catch { /* the page is out of reach: keep the cached value */ }
}

// Hides a band that is up while Codex has been idle for the set time: nothing running, no job update and no
// hand-off since. A later Codex hand-off or command brings it back.
export async function autoHide($: EngineInterface, jobs: CodexJob[], me: string, now: number) {
  if (await read($, isHidden)) return
  const isVisible = (await read($, isShown)) || jobs.some(j => j.sessionId === me)
  if (!isVisible || jobs.some(active)) return
  const minutes = await hideMinutes($)
  if (minutes <= 0) return
  const lastJob = Math.max(0, ...jobs.map(j => Date.parse(j.updatedAt ?? j.completedAt ?? '') || 0))
  const since = Math.max(lastJob, await read($, shownAt))
  if (now - since >= minutes * 60000) await setShown($, false)
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

async function logJob($: EngineInterface, url: string, job: CodexJob, command: string, known: LoggedRows[string] | undefined) {
  const base = { tool: 'ArtifactData', url, collection: COLLECTION, doc_id: job.id }
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
    hasTriedPage = false

    const sync = async (jobs: CodexJob[]) => {
      if (isSyncing) return
      isSyncing = true
      try {
        const me = await $.session.id()
        const own = jobs.filter(j => j.sessionId === me)
        const url = own.length ? await ensurePage($) : null
        if (!url) return
        const rows = await read($, logged)
        const command = await read($, lastCommand)
        for (const job of own) {
          const known = rows[job.id]
          if (known?.status === job.status) continue
          const version = await logJob($, url, job, command, known)
          if (version !== null) await update($, logged, all => ({ ...all, [job.id]: { status: job.status, version } }))
        }
      } catch { /* the page is out of reach (offline, signed out): next scan */ } finally {
        isSyncing = false
      }
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
      const isFromPage = !found
      if (isFromPage) jobs.push(...(await readPageJobs($)))
      jobs.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      await update($, snapshot, () => ({ found, isFromPage, jobs: jobs.slice(0, 20), checkedAt: Date.now() }))
      void sync(jobs)
      await autoHide($, jobs, await $.session.id(), Date.now())
      const armed = await read($, stopArmed)
      if (armed.id && Date.now() - armed.at > ARM_MS) await update($, stopArmed, () => ({ id: '', at: 0 }))
    }
    rescan = scan

    await scan()
    $.clock.every(15000, () => { void scan() })
    void refreshSettings($)
    $.clock.every(SETTINGS_EVERY_MS, () => { void refreshSettings($) })
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

  on('tool.check', { tool: ['ArtifactData', 'Artifact'] }, async ($, e, next) =>
    next.origin.plugin === $.plugin.name && isOwnPageCall(e.tool, e.input, await storedPage($)) ? { decision: 'allow' } : next(e),
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
    const url = await storedPage($)
    if (!mine.length || !url) return composed
    const text = `Codex requests page (${url}): codex-band logs each Codex job of this session in its "${COLLECTION}" collection, doc id = the Codex job id (${mine.map(j => j.id).slice(0, 5).join(', ')}). When you act on a job's findings, add them to that row with ArtifactData update: findings [{ priority, title, state: pending|fixed|rejected|later, action }], and pr, commit or summary where known. Never create a second row for the same job.`
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

    // The head sits on the button row; the detail goes on the line below it.
    let head: string
    let detail = ''
    const j = running[0]
    if (j) {
      const mins = minutesSince(j.startedAt, now)
      head = `Codex ${j.kind} running`
      detail = `in ${j.workspace}${j.phase ? `: ${j.phase}` : ''}${mins !== null ? `, ${mins} min` : ''}`
      if (running.length > 1) detail += ` (+${running.length - 1} more)`
    } else if (last) {
      const mins = minutesSince(last.updatedAt, now)
      const ago = mins === null ? '' : mins < 90 ? ` ${mins} min ago` : mins < 2880 ? ` ${Math.round(mins / 60)} h ago` : ` ${Math.round(mins / 1440)} d ago`
      head = 'Codex idle'
      detail = `Last ${last.kind} in ${last.workspace} ${last.status}${ago}`
    } else {
      const isKnown = snap.found || snap.isFromPage
      head = isKnown ? 'Codex idle' : 'Codex runs on the desktop'
      detail = isKnown ? 'No jobs yet' : ''
    }

    const armed = await read($, stopArmed)
    const isArmed = Boolean(j) && armed.id === j?.id && now - armed.at < ARM_MS
    const onStop = async () => {
      if (!j) return $.ui.toast('No Codex job is running.')
      if (snap.isFromPage) return $.ui.toast(`Codex runs on the desktop: stop this ${j.kind} there.`)
      if (!isArmed) return update($, stopArmed, () => ({ id: j.id, at: Date.now() }))
      await update($, stopArmed, () => ({ id: '', at: 0 }))
      await stopJob($, j)
    }

    // Mobile draws on another device than the host, so there the page stays a link.
    const url = await storedPage($)
    const requests = e.surface === 'mobile'
      ? (url ? <Link href={url} label="Requests" /> : null)
      : <Button key="requests" label="Requests" onPress={() => openPage($)} />
    const isTerminal = e.surface === 'terminal'

    const pad = isTerminal ? 0 : 1
    // The band holds one tree: stack whatever the mods beneath draw under ours, so they don't vanish.
    const below = await next(e)
    return (
      <Box flexDirection="column">
      <Box flexDirection="column" borderStyle={isTerminal ? 'round' : undefined} borderDimColor paddingX={isTerminal ? 1 : 0}>
        <Box justifyContent="space-between" alignItems="center">
          <Box paddingLeft={pad}>
            <Text color={running.length ? (isPulsing ? 'greenBright' : 'green') : 'gray'} dimColor={!running.length || !isPulsing}>● </Text>
            <Text color={running.length ? 'yellow' : undefined} dimColor={!running.length}>{head}</Text>
          </Box>
          <Box gap={1}>
            {requests}
            {/* No Button can be disabled: idle, Stop is drawn dim, keeps that look under the pointer, and its press only says so. */}
            <Box key="stop-area"><Button key="stop" label={isArmed ? 'Confirm stop' : 'Stop'} dimColor={!j || snap.isFromPage} hover={j && !snap.isFromPage ? undefined : { dimColor: true }} onPress={onStop} /></Box>
            <Button key="hide" label="Hide" onPress={() => setShown($, false)} />
          </Box>
        </Box>
        {/* Indented past the light so the detail lines up under the head. */}
        {detail ? <Box paddingLeft={pad + 2}><Text dimColor>{detail}</Text></Box> : null}
      </Box>
      {below}
      </Box>
    )
  })
}
