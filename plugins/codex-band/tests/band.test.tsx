import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'codex-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100 },
} as const

function engine(on: Parameters<Parameters<typeof test>[1]>[1], jobs: object[] = []) {
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
  on('tool.call', () => ({ result: {} }))
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
