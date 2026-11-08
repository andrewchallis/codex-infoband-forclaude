import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'codex-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100 },
} as const

function engine(on: Parameters<Parameters<typeof test>[1]>[1], jobs: object[] = [], onTool?: (e: Record<string, unknown>) => void) {
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/a' : undefined }))
  on('fs.list', (_, e) => ({
    value: [{ name: /state$/.test(e.path) ? 'ws-0123456789abcdef' : 'codex-openai-codex', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }],
  }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify({ jobs }) }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'codex-band' } }))
  on('session.id', () => ({ value: 'me' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) => { onTool?.(e as Record<string, unknown>); return { result: {}, text: 'version 1' } })
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

const PAGE = 'https://claude.ai/artifact/Dn5pxYxHT9N3joEr8Tbf5Y'

test("this session's Codex job is logged on the page, its own write approved without a prompt", async ($, on) => {
  const me = 'me'
  const job = { id: 'review-1', status: 'running', kindLabel: 'review', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sessionId: me }
  const other = { ...job, id: 'review-2', sessionId: 'other' }
  const writes: Record<string, unknown>[] = []
  engine(on, [job, other], e => { if (e.tool === 'ArtifactData') writes.push(e) })
  // Beneath the mod everything asks, as a session's default would: only the mod's own page write may pass.
  on('tool.check', () => ({ decision: 'ask' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.unmount()

  expect(writes.length).toBe(1)
  expect(writes[0]).toMatchObject({ action: 'set', url: PAGE, collection: 'requests', doc_id: 'review-1', data: { kind: 'review', status: 'running' } })

  const asked = await $.tool.check({ tool: 'ArtifactData', input: { action: 'set', url: PAGE, collection: 'requests', doc_id: 'x' } })
  expect(asked.decision).toBe('ask')
})
