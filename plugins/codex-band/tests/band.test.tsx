import { expect, test } from 'claude-code/testing'
import { isOwnPageCall, jobsFromPage } from '../hooks/register'

const BAND = {
  plugin: 'codex-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100 },
} as const

function engine(on: Parameters<Parameters<typeof test>[1]>[1], jobs: object[] = [], onTool?: (e: Record<string, unknown>) => { text?: string } | void, onRun?: (argv: readonly string[]) => void, store: Record<string, unknown> = {}, hasJobFiles = true) {
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => { store[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_, e) => { delete store[e.key]; return { value: undefined } })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/a' : undefined }))
  on('fs.list', (_, e) => (!hasJobFiles ? { value: [] } : {
    value: [{ name: /state$/.test(e.path) ? 'ws-0123456789abcdef' : 'codex-openai-codex', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }],
  }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify({ jobs }) }))
  on('clock.every', () => ({ value: undefined }))
  on('process.run', (_, e) => { onRun?.(e.argv); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'codex-band' } }))
  on('session.id', () => ({ value: 'me' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) => ({ result: {}, text: 'version 1', ...(onTool?.(e as Record<string, unknown>) ?? {}) }))
  on('command.run', () => ({ text: 'engine' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

const banded = async (ui: { find: (q: { type: 'Text'; text: RegExp }) => Promise<unknown> }) =>
  (await ui.find({ type: 'Text', text: /Codex/ })) != null

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: hidden in a new chat, shown once a Codex hand-off is proposed`, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })

    let ui = await $.ui.mount({ ...BAND, surface })
    expect(await banded(ui)).toBe(false)
    await ui.unmount()

    await $.tool.call({ tool: 'Bash', command: 'git status' })
    ui = await $.ui.mount({ ...BAND, surface })
    expect(await banded(ui)).toBe(false)
    await ui.unmount()

    await $.tool.call({ tool: 'Bash', command: 'node "/p/scripts/codex-companion.mjs" task --background "fix it"' })
    ui = await $.ui.mount({ ...BAND, surface })
    expect(await banded(ui)).toBe(true)
    await ui.press({ key: 'hide' })
    expect(await banded(ui)).toBe(false)
    await ui.unmount()
  })

  test(`${surface}: shown when this session has a Codex job`, async ($, on) => {
    const job = { id: 'j', status: 'completed', kindLabel: 'review', updatedAt: new Date().toISOString() }
    engine(on, [{ ...job, sessionId: 'me' }])
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await banded(ui)).toBe(true)
    await ui.unmount()
  })

  test(`${surface}: another session's job keeps it hidden; /codex-band shows it`, async ($, on) => {
    engine(on, [{ id: 'j', status: 'running', kindLabel: 'review', updatedAt: new Date().toISOString(), sessionId: 'other' }])
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    let ui = await $.ui.mount({ ...BAND, surface })
    expect(await banded(ui)).toBe(false)
    await ui.unmount()

    await $.command.run({ command: 'codex-band', args: '' })
    ui = await $.ui.mount({ ...BAND, surface })
    expect(await banded(ui)).toBe(true)
    await ui.unmount()
  })
}

test('the band skill and commands do not count as Codex work', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'claude plugin update codex-band@codex-infoband-forclaude' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await banded(ui)).toBe(false)
  await ui.unmount()
})

const NEW_PAGE = 'https://claude.ai/artifact/NewPage123'
const MINE = 'https://claude.ai/artifact/Mine456'
const runningJob = () => ({ id: 'review-1', status: 'running', kindLabel: 'review', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sessionId: 'me' })

test("first Codex job: no page yet, so one is created (asking as usual) and the job logged on it", async ($, on) => {
  const calls: Record<string, unknown>[] = []
  engine(on, [runningJob(), { ...runningJob(), id: 'review-2', sessionId: 'other' }], e => {
    calls.push(e)
    if (e.tool === 'Artifact' && e.action === 'list') return { text: '- (mine) Codex Requests — https://claude.ai/artifact/SomeoneElses — updated' }
    if (e.tool === 'Artifact' && e.action === 'publish') return { text: `Published page at ${NEW_PAGE} (Version 1)` }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.unmount()

  // The similarly named page is not taken for this mod's own.
  expect(calls.find(c => c.action === 'publish')).toMatchObject({ title: 'Codex Band Requests', capabilities: { db: { rules: [{ path: 'requests', read: 'view', write: 'owner' }, { path: 'settings', read: 'view', write: 'owner' }] } } })
  const writes = calls.filter(c => c.tool === 'ArtifactData' && c.action !== 'get')
  expect(writes.map(w => `${w.action} ${w.collection}`)).toEqual(['set requests'])
  expect(writes[0]).toMatchObject({ action: 'set', url: NEW_PAGE, collection: 'requests', doc_id: 'review-1', data: { kind: 'review', status: 'running' } })
})

test("a page of the person's with this mod's title is adopted, nothing created", async ($, on) => {
  const calls: Record<string, unknown>[] = []
  engine(on, [runningJob()], e => {
    calls.push(e)
    if (e.tool === 'Artifact' && e.action === 'list') return { text: `- (mine) Other — https://claude.ai/artifact/Nope — updated
- (mine) Codex Band Requests — ${MINE} — updated 2026-11-08` }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await (await $.ui.mount({ ...BAND, surface: 'desktop' })).unmount()
  expect(calls.some(c => c.action === 'publish')).toBe(false)
  expect(calls.find(c => c.tool === 'ArtifactData')).toMatchObject({ url: MINE, doc_id: 'review-1' })
})

test('a remembered page is used without listing', async ($, on) => {
  const calls: Record<string, unknown>[] = []
  engine(on, [runningJob()], e => { calls.push(e) }, undefined, { pageUrl: MINE })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await (await $.ui.mount({ ...BAND, surface: 'desktop' })).unmount()
  expect(calls.some(c => c.tool === 'Artifact')).toBe(false)
  expect(calls.find(c => c.tool === 'ArtifactData')).toMatchObject({ url: MINE })
})

test('the mod pre-approves only its own page rows and its artifact listing, never creating a page', () => {
  expect(isOwnPageCall('ArtifactData', { action: 'set', url: MINE, collection: 'requests' }, MINE)).toBe(true)
  expect(isOwnPageCall('ArtifactData', { action: 'delete', url: MINE, collection: 'requests' }, MINE)).toBe(false)
  expect(isOwnPageCall('ArtifactData', { action: 'set', url: NEW_PAGE, collection: 'requests' }, MINE)).toBe(false)
  expect(isOwnPageCall('ArtifactData', { action: 'set', url: MINE, collection: 'other' }, MINE)).toBe(false)
  expect(isOwnPageCall('ArtifactData', { action: 'set', url: MINE, collection: 'requests' }, null)).toBe(false)
  expect(isOwnPageCall('Artifact', { action: 'list' }, null)).toBe(true)
  expect(isOwnPageCall('Artifact', { action: 'publish' }, null)).toBe(false)
  expect(isOwnPageCall('Artifact', { action: 'delete', url: MINE }, MINE)).toBe(false)
})

for (const [minutes, isUp] of [[undefined, false], [0, true], [120, true]] as const) {
  test(`auto-hide: this session's job finished an hour ago, hide after ${minutes ?? 'the default 10'} min -> ${isUp ? 'up' : 'hidden'}`, async ($, on) => {
    const hourAgo = new Date(Date.now() - 3600e3).toISOString()
    const store: Record<string, unknown> = minutes === undefined ? {} : { autoHideMinutes: minutes }
    engine(on, [{ id: 'j', status: 'completed', kindLabel: 'review', updatedAt: hourAgo, sessionId: 'me' }], undefined, undefined, store)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await banded(ui)).toBe(isUp)
    await ui.unmount()
  })
}

test('auto-hide never hides while a job runs', async ($, on) => {
  engine(on, [{ id: 'r', status: 'running', kindLabel: 'task', updatedAt: new Date().toISOString(), sessionId: 'me' }])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await banded(ui)).toBe(true)
  await ui.unmount()
})

test('page rows read as jobs: finished is completed, a long-silent running row is stalled', () => {
  const now = Date.parse('2026-11-08T12:00:00Z')
  const text = [
    '=== BEGIN ARTIFACT DB x ===',
    JSON.stringify({ id: 'a', data: { kind: 'review', status: 'finished', sentAt: '2026-11-08T11:00:00Z', finishedAt: '2026-11-08T11:10:00Z', thread: 'repo-one' } }),
    JSON.stringify({ id: 'b', data: { kind: 'task', status: 'running', sentAt: '2026-11-08T11:50:00Z' } }),
    JSON.stringify({ id: 'c', data: { kind: 'task', status: 'running', sentAt: '2026-11-07T11:50:00Z' } }),
    '=== END ARTIFACT DB x ===',
  ].join('\n')
  const jobs = jobsFromPage(text, now)
  expect(jobs.map(j => `${j.id} ${j.status}`)).toEqual(['a completed', 'b running', 'c stalled'])
  expect(jobs[0]).toMatchObject({ workspace: 'repo-one', updatedAt: '2026-11-08T11:10:00Z' })
})

test('cloud session (no Codex job files): the band shows the page rows once a desktop hand-off is sent, and Stop points to the desktop', async ($, on) => {
  const runs: string[][] = []
  const row = JSON.stringify({ id: 'r1', data: { kind: 'review', status: 'running', sentAt: new Date().toISOString(), thread: 'repo-one' } })
  engine(on, [], e => (e.tool === 'ArtifactData' && e.action === 'list' ? { text: `1 document\n${row}\n` } : undefined), argv => { runs.push([...argv]) }, { pageUrl: MINE }, false)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await banded(ui)).toBe(false)
  await ui.unmount()

  await $.tool.call({ tool: 'SendMessage', to: 'desktop', message: 'Please run /codex:rescue --background the brief' })
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /running/ }) as { text?: string } | null)?.text).toBe('Codex review running')
  await ui.press({ key: 'stop' })
  await ui.press({ key: 'stop' })
  expect(runs.some(a => a.includes('cancel'))).toBe(false)
  await ui.unmount()
})

test('Stop cancels the running job only on the confirming press; Requests opens the page', async ($, on) => {
  const job = { id: 'task-9', status: 'running', kindLabel: 'task', updatedAt: new Date().toISOString(), sessionId: 'me', workspaceRoot: '/work/w' }
  const runs: string[][] = []
  engine(on, [job], undefined, argv => { runs.push([...argv]) }, { pageUrl: MINE })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'codex-band', args: '' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  await ui.press({ key: 'stop' })
  expect(runs.some(a => a.includes('cancel'))).toBe(false)
  await ui.press({ key: 'stop' })
  const cancel = runs.find(a => a.includes('cancel'))
  expect(cancel?.slice(2)).toEqual(['cancel', 'task-9', '--cwd', '/work/w', '--json'])

  await ui.press({ key: 'requests' })
  expect(runs.some(a => a.includes(MINE))).toBe(true)
  await ui.unmount()
})
