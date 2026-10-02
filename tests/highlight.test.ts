import type { RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const ENGINE_ROW: RenderElement = { type: 'Text', props: {}, children: ['engine row'] }

function row(tool: string, input: unknown) {
  return {
    plugin: 'shell-highlight',
    component: 'ToolUse',
    requestId: 'toolu_1',
    viewport: { columns: 100, rows: 30, isFullscreen: false },
    props: { tool_use_id: 'toolu_1', tool, input, isRunning: false, isErrored: false, isInterrupted: false },
  } as const
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a Bash command is drawn as highlighted code`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('Bash', { command: 'cd ~/.claude && ls -la', description: 'List' }), surface })
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    expect(await ui.find({ text: 'engine row' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: a PowerShell command is drawn as highlighted code`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('PowerShell', { command: 'Get-ChildItem -Force' }), surface })
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a grouped call folds its output behind a button`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const call = { tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'seq 1 8' } }
    const state = { isRunning: false, isErrored: false, isInterrupted: false }
    const group = await $.ui.mount({
      plugin: 'shell-highlight',
      surface,
      component: 'ToolGroup',
      requestId: 'group_1',
      viewport: { columns: 100, rows: 30, isFullscreen: false },
      props: { calls: [{ ...call, ...state }], isActive: false, isExpanded: false },
    })
    const stdout = [1, 2, 3, 4, 5, 6, 7, 8].map(n => `line ${n}`).join('\n')
    const base = row('Bash', call.input)
    const ui = await $.ui.mount({ ...base, props: { ...base.props, output: { stdout, stderr: '' } }, surface })
    expect(await ui.find({ text: 'line 5' })).toBeDefined()
    expect(await ui.find({ text: 'line 6' })).toBeUndefined()
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ text: 'line 6' })).toBeDefined()
    await ui.unmount()
    await group.unmount()
  })

  test(`${surface}: other tools keep the engine's row`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('Read', { file_path: 'README.md' }), surface })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ text: 'engine row' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a command Code would refuse keeps the engine's row`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('Bash', { command: 'printf "\u001b[31mred"' }), surface })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ text: 'engine row' })).toBeDefined()
    await ui.unmount()
  })
}
