import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ENGINE_ROW: RenderElement = { type: 'Text', props: {}, children: ['engine row'] }
const VIEWPORT = { columns: 100, rows: 30, isFullscreen: true }
const DONE = { isRunning: false, isErrored: false, isInterrupted: false }
const EIGHT_LINES = [1, 2, 3, 4, 5, 6, 7, 8].map(n => `line ${n}`).join('\n')

function row(tool: string, input: unknown, more: Record<string, unknown> = {}) {
  return {
    plugin: 'shell-highlight',
    component: 'ToolUse',
    requestId: 'toolu_1',
    viewport: VIEWPORT,
    props: { tool_use_id: 'toolu_1', tool, input, ...DONE, ...more },
  } as const
}

type GroupCall = { tool: string; input: unknown; tool_use_id?: string; output?: unknown }

function memoryStore(on: On, entries: Record<string, unknown>) {
  const saved = new Map(Object.entries(entries))
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  return saved
}

function group(calls: readonly GroupCall[], isExpanded = false) {
  return {
    plugin: 'shell-highlight',
    component: 'ToolGroup',
    requestId: 'group_1',
    viewport: VIEWPORT,
    props: { calls: calls.map(call => ({ ...DONE, ...call })), isActive: false, isExpanded },
  } as const
}

const SEQ = { tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'seq 1 8' }, output: { stdout: EIGHT_LINES, stderr: '' } }
const READ = { tool_use_id: 'toolu_2', tool: 'Read', input: { file_path: 'README.md' } }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a Bash command is drawn as highlighted code`, async ($, on) => {
    mock.store(on, {})
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('Bash', { command: 'cd ~/.claude && ls -la', description: 'List' }), surface })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'cd ~/.claude && ls -la', language: 'bash' })
    expect(await ui.find({ text: 'List' })).toBeDefined()
    expect(await ui.find({ text: 'engine row' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: a PowerShell command is drawn as highlighted code`, async ($, on) => {
    mock.store(on, {})
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('PowerShell', { command: 'Get-ChildItem -Force' }), surface })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ language: 'powershell' })
    await ui.unmount()
  })

  test(`${surface}: an embedded script is highlighted in its own language`, async ($, on) => {
    mock.store(on, {})
    on('ui.render', () => ENGINE_ROW)
    const command = "node <<'EOF'\nconsole.log(1)\nEOF"
    const ui = await $.ui.mount({ ...row('Bash', { command }), surface })
    const languages = (await ui.findAll({ type: 'Code' })).map(code => code.props?.language)
    expect(languages).toEqual(['bash', 'javascript', 'bash'])
    await ui.unmount()
  })

  test(`${surface}: a command with control characters is still drawn`, async ($, on) => {
    mock.store(on, {})
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('Bash', { command: 'printf "\u001b[31mred"' }), surface })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'printf "␛[31mred"' })
    await ui.unmount()
  })

  test(`${surface}: a command longer than one element is drawn in several`, async ($, on) => {
    mock.store(on, {})
    on('ui.render', () => ENGINE_ROW)
    const command = Array.from({ length: 8 }, (_, n) => `echo ${'x'.repeat(3000)}${n}`).join('\n')
    const ui = await $.ui.mount({ ...row('Bash', { command }), surface })
    expect((await ui.findAll({ type: 'Code' })).length).toBe(3)
    await ui.unmount()
  })

  test(`${surface}: the engine's result block is left empty for a row the mod drew`, async ($, on) => {
    mock.store(on, {})
    on('ui.render', () => ENGINE_ROW)
    const result = { tool_use_id: 'toolu_1', tool: 'Bash', output: SEQ.output, isErrored: false }
    const target = { plugin: 'shell-highlight', component: 'ToolResult', requestId: 'toolu_1', viewport: VIEWPORT, props: result, surface } as const

    const before = await $.ui.mount(target)
    expect(await before.find({ text: 'engine row' })).toBeDefined()
    await before.unmount()

    const drawn = await $.ui.mount({ ...row('Bash', SEQ.input, { output: SEQ.output }), surface })
    expect(await drawn.find({ text: 'line 1' })).toBeDefined()
    const after = await $.ui.mount(target)
    expect(await after.find({ text: 'engine row' })).toBeUndefined()
    await after.unmount()
    await drawn.unmount()
  })

  test(`${surface}: other tools keep the engine's row`, async ($, on) => {
    mock.store(on, {})
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('Read', READ.input), surface })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ text: 'engine row' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a group without shell calls is left alone`, async ($, on) => {
    mock.store(on, {})
    const seen: boolean[] = []
    on('ui.render', ($$, e) => {
      if (e.component === 'ToolGroup') seen.push(e.props.isExpanded)
      return ENGINE_ROW
    })
    const ui = await $.ui.mount({ ...group([READ]), surface })
    expect(seen).toEqual([false])
    expect(await ui.find({ text: 'engine row' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a group of only shell calls is unfolded into rows`, async ($, on) => {
    mock.store(on, {})
    const seen: boolean[] = []
    on('ui.render', ($$, e) => {
      if (e.component === 'ToolGroup') seen.push(e.props.isExpanded)
      return ENGINE_ROW
    })
    const ui = await $.ui.mount({ ...group([SEQ]), surface })
    expect(seen).toEqual([true])
    await ui.unmount()
  })

  test(`${surface}: a mixed group keeps the engine's line and adds the shell rows`, async ($, on) => {
    mock.store(on, {})
    const seen: boolean[] = []
    on('ui.render', ($$, e) => {
      if (e.component === 'ToolGroup') seen.push(e.props.isExpanded)
      return ENGINE_ROW
    })
    const ui = await $.ui.mount({ ...group([READ, SEQ]), surface })
    expect(seen).toEqual([false])
    expect(await ui.find({ text: 'engine row' })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'seq 1 8' })
    expect(await ui.find({ text: 'line 5' })).toBeDefined()
    expect(await ui.find({ text: 'line 6' })).toBeUndefined()
    expect(await ui.find({ text: '… +3 lines' })).toBeDefined()
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: a row of an unfolded group folds its output behind a button`, async ($, on) => {
    const store = memoryStore(on, {})
    on('ui.render', () => ENGINE_ROW)
    const unfolded = await $.ui.mount({ ...group([SEQ]), surface })
    const ui = await $.ui.mount({ ...row('Bash', SEQ.input, { output: SEQ.output }), surface })
    expect(await ui.find({ text: 'line 5' })).toBeDefined()
    expect(await ui.find({ text: 'line 6' })).toBeUndefined()
    expect((await ui.find({ type: 'Button' }))?.props).toMatchObject({ label: '… +3 lines' })

    await ui.press({ key: 'toggle-toolu_1' })
    expect(await ui.find({ text: 'line 8' })).toBeDefined()
    expect((await ui.find({ type: 'Button' }))?.props).toMatchObject({ label: 'show less' })
    expect(store.get('expanded')).toEqual(['toolu_1'])

    await ui.press({ key: 'toggle-toolu_1' })
    expect(await ui.find({ text: 'line 6' })).toBeUndefined()
    expect(store.get('expanded')).toEqual([])
    await ui.unmount()
    await unfolded.unmount()
  })

  test(`${surface}: unfolded rows are remembered across sessions`, async ($, on) => {
    mock.store(on, { expanded: ['toolu_1'] })
    on('ui.render', () => ENGINE_ROW)
    on('session.start', () => ({ cwd: '/work' }))
    await $.session.start({ cwd: '/work', surface, isInteractive: true })
    const unfolded = await $.ui.mount({ ...group([SEQ]), surface })
    const ui = await $.ui.mount({ ...row('Bash', SEQ.input, { output: SEQ.output }), surface })
    expect(await ui.find({ text: 'line 8' })).toBeDefined()
    await ui.unmount()
    await unfolded.unmount()
  })

  test(`${surface}: a long command is folded with the output`, async ($, on) => {
    mock.store(on, {})
    on('ui.render', () => ENGINE_ROW)
    const command = Array.from({ length: 14 }, (_, n) => `echo ${n + 1}`).join('\n')
    const call = { tool_use_id: 'toolu_1', tool: 'Bash', input: { command }, output: { stdout: 'ok', stderr: '' } }
    const unfolded = await $.ui.mount({ ...group([call]), surface })
    const ui = await $.ui.mount({ ...row('Bash', call.input, { output: call.output }), surface })
    expect((await ui.find({ type: 'Code' }))?.props?.source).toBe(command.split('\n').slice(0, 10).join('\n'))
    expect((await ui.find({ type: 'Button' }))?.props).toMatchObject({ label: '… +4 lines' })
    await ui.press({ key: 'toggle-toolu_1' })
    expect((await ui.find({ type: 'Code' }))?.props?.source).toBe(command)
    await ui.unmount()
    await unfolded.unmount()
  })

  test(`${surface}: a call without output says so, a running one says it runs`, async ($, on) => {
    mock.store(on, {})
    on('ui.render', () => ENGINE_ROW)
    const quiet = { tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'true' }, output: { stdout: '', stderr: '' } }
    const unfolded = await $.ui.mount({ ...group([quiet]), surface })
    const ui = await $.ui.mount({ ...row('Bash', quiet.input, { output: quiet.output }), surface })
    expect(await ui.find({ text: '(no output)' })).toBeDefined()
    await ui.redraw({ tool_use_id: 'toolu_1', tool: 'Bash', input: quiet.input, ...DONE, isRunning: true })
    expect(await ui.find({ text: 'Running…' })).toBeDefined()
    await ui.unmount()
    await unfolded.unmount()
  })
}
