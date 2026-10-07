import type { RenderElement } from 'claude-code'
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
const LONG_COMMAND = Array.from({ length: 14 }, (_, n) => `echo ${n + 1}`).join('\n')
const LONG = { tool_use_id: 'toolu_1', tool: 'Bash', input: { command: LONG_COMMAND }, output: { stdout: 'ok', stderr: '' } }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a Bash command is drawn as highlighted code`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('Bash', { command: 'cd ~/.claude && ls -la', description: 'List' }), surface })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'cd ~/.claude && ls -la', language: 'bash' })
    expect(await ui.find({ text: 'List' })).toBeDefined()
    expect(await ui.find({ text: 'engine row' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: a PowerShell command is drawn as highlighted code`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('PowerShell', { command: 'Get-ChildItem -Force' }), surface })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ language: 'powershell' })
    await ui.unmount()
  })

  test(`${surface}: an embedded script is highlighted in its own language`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const command = "node <<'EOF'\nconsole.log(1)\nEOF"
    const ui = await $.ui.mount({ ...row('Bash', { command }), surface })
    const languages = (await ui.findAll({ type: 'Code' })).map(code => code.props?.language)
    expect(languages).toEqual(['bash', 'javascript', 'bash'])
    await ui.unmount()
  })

  test(`${surface}: a command with control characters is still drawn`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('Bash', { command: 'printf "\u001b[31mred"' }), surface })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'printf "␛[31mred"' })
    await ui.unmount()
  })

  test(`${surface}: a command longer than one element is drawn in several`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const command = Array.from({ length: 8 }, (_, n) => `echo ${'x'.repeat(3000)}${n}`).join('\n')
    const ui = await $.ui.mount({ ...row('Bash', { command }), surface })
    expect((await ui.findAll({ type: 'Code' })).length).toBe(3)
    await ui.unmount()
  })

  test(`${surface}: a row of an unfolded group shows the whole command and the whole output`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const unfolded = await $.ui.mount({ ...group([{ ...LONG, output: SEQ.output }], true), surface })
    const ui = await $.ui.mount({ ...row('Bash', LONG.input, { output: SEQ.output }), surface })
    expect((await ui.find({ type: 'Code' }))?.props?.source).toBe(LONG_COMMAND)
    expect(await ui.find({ text: 'line 8' })).toBeDefined()
    await ui.unmount()
    await unfolded.unmount()
  })

  test(`${surface}: a row of an unfolded group without output says so, a running one says it runs`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const input = { command: 'true' }
    const output = { stdout: '', stderr: '' }
    const unfolded = await $.ui.mount({ ...group([{ tool_use_id: 'toolu_1', tool: 'Bash', input, output }], true), surface })
    const ui = await $.ui.mount({ ...row('Bash', input, { output }), surface })
    expect(await ui.find({ text: '(no output)' })).toBeDefined()
    await ui.redraw({ tool_use_id: 'toolu_1', tool: 'Bash', input, ...DONE, isRunning: true })
    expect(await ui.find({ text: 'Running…' })).toBeDefined()
    await ui.unmount()
    await unfolded.unmount()
  })

  test(`${surface}: a row on its own draws the command and leaves the output to the engine`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('Bash', SEQ.input, { output: SEQ.output }), surface })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'seq 1 8' })
    expect(await ui.find({ text: 'line 1' })).toBeUndefined()
    await ui.unmount()

    const result = { tool_use_id: 'toolu_1', tool: 'Bash', output: SEQ.output, isErrored: false }
    const block = await $.ui.mount({ plugin: 'shell-highlight', component: 'ToolResult', requestId: 'toolu_1', viewport: VIEWPORT, props: result, surface })
    expect(await block.find({ text: 'engine row' })).toBeDefined()
    await block.unmount()
  })

  test(`${surface}: a call that has not run yet has no output line`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('Bash', { command: 'true' }), surface })
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    expect(await ui.find({ text: '(no output)' })).toBeUndefined()
    expect(await ui.find({ text: '⎿' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: the engine's result block is left empty for a row that drew its output`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const result = { tool_use_id: 'toolu_1', tool: 'Bash', output: SEQ.output, isErrored: false }
    const target = { plugin: 'shell-highlight', component: 'ToolResult', requestId: 'toolu_1', viewport: VIEWPORT, props: result, surface } as const

    const unfolded = await $.ui.mount({ ...group([SEQ], true), surface })
    const drawn = await $.ui.mount({ ...row('Bash', SEQ.input, { output: SEQ.output }), surface })
    expect(await drawn.find({ text: 'line 1' })).toBeDefined()
    const block = await $.ui.mount(target)
    expect(await block.find({ text: 'engine row' })).toBeUndefined()
    await block.unmount()
    await drawn.unmount()
    await unfolded.unmount()
  })

  test(`${surface}: other tools keep the engine's row`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('Glob', { pattern: '*.md' }), surface })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ text: 'engine row' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a group without shell calls is left alone`, async ($, on) => {
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

  test(`${surface}: a folded group of shell calls is drawn as folded commands`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...group([SEQ]), surface })
    expect(await ui.find({ text: 'engine row' })).toBeUndefined()
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'seq 1 8' })
    expect(await ui.find({ text: 'line 5' })).toBeDefined()
    expect(await ui.find({ text: 'line 6' })).toBeUndefined()
    expect(await ui.find({ text: '… +3 lines (click to expand)' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a folded group cuts a long command and counts its lines`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...group([LONG]), surface })
    expect((await ui.find({ type: 'Code' }))?.props?.source).toBe(LONG_COMMAND.split('\n').slice(0, 10).join('\n'))
    expect(await ui.find({ text: '… +4 lines (click to expand)' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a folded mixed group keeps the engine's line above the commands`, async ($, on) => {
    const seen: boolean[] = []
    on('ui.render', ($$, e) => {
      if (e.component === 'ToolGroup') seen.push(e.props.isExpanded)
      return ENGINE_ROW
    })
    const ui = await $.ui.mount({ ...group([READ, SEQ]), surface })
    expect(seen).toEqual([false])
    expect(await ui.find({ text: 'engine row' })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'seq 1 8' })
    expect(await ui.find({ text: '… +3 lines (click to expand)' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a Read row draws its path as a link that opens the file`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const opened: string[][] = []
    on('process.run', ($$, e) => {
      opened.push([...e.argv])
      return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const ui = await $.ui.mount({ ...row('Read', { file_path: 'C:\\work\\a (1).md', offset: 1, limit: 5 }), surface })
    const head = await ui.find({ type: 'Markdown' })
    expect(head?.props?.text).toBe('**Read**([C:\\\\work\\\\a \\(1\\)\\.md](file:///C:/work/a%20%281%29.md) · lines 1\\-5)')
    expect(await ui.find({ text: 'engine row' })).toBeUndefined()
    await ui.press({ key: 'path-toolu_1', link: { href: 'file:///C:/work/a%20%281%29.md' } })
    expect(opened).toEqual([['explorer.exe', 'C:\\work\\a (1).md']])
    await ui.unmount()
  })

  test(`${surface}: a path in a command is a link that opens the file`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const opened: string[][] = []
    on('process.run', ($$, e) => {
      opened.push([...e.argv])
      return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const ui = await $.ui.mount({ ...row('PowerShell', { command: 'node "C:\\a\\run.mjs"' }), surface })
    expect((await ui.find({ type: 'Markdown', key: 'link-toolu_1-0' }))?.props?.text).toBe('[C:\\\\a\\\\run\\.mjs](file:///C:/a/run.mjs)')
    await ui.press({ key: 'link-toolu_1-0', link: { href: 'file:///C:/a/run.mjs' } })
    expect(opened).toEqual([['explorer.exe', 'C:\\a\\run.mjs']])
    await ui.unmount()
  })

  test(`${surface}: a ~ path in a reply is a link that opens it under the home directory`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    mock.env(on, { USERPROFILE: 'C:\\Users\\me' })
    on('session.start', () => ({ cwd: 'C:\\work' }))
    const opened: string[][] = []
    on('process.run', ($$, e) => {
      opened.push([...e.argv])
      return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    await $.session.start({ surface, isInteractive: true, cwd: 'C:\\work' })
    const props = { text: 'Repo: `~/Documents/source/x`', isFirstOfReply: true }
    const ui = await $.ui.mount({ plugin: 'shell-highlight', component: 'AssistantMessage', requestId: 'msg_1', viewport: VIEWPORT, props, surface })
    expect((await ui.find({ type: 'Markdown' }))?.props?.text).toBe('Repo: [\\~/Documents/source/x](file:///C:/Users/me/Documents/source/x)')
    await ui.press({ key: 'reply-msg_1', link: { href: 'file:///C:/Users/me/Documents/source/x' } })
    expect(opened).toEqual([['explorer.exe', 'C:\\Users\\me\\Documents\\source\\x']])
    await ui.unmount()
  })

  test(`${surface}: a reply without paths is the engine's`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const props = { text: 'Nothing to see', isFirstOfReply: true }
    const ui = await $.ui.mount({ plugin: 'shell-highlight', component: 'AssistantMessage', requestId: 'msg_1', viewport: VIEWPORT, props, surface })
    expect(await ui.find({ text: 'engine row' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a Windows folder is opened through PowerShell so its window comes to the front`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }))
    const opened: string[][] = []
    on('process.run', ($$, e) => {
      opened.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const ui = await $.ui.mount({ ...row('PowerShell', { command: 'dir C:\\work\\here' }), surface })
    await ui.press({ key: 'link-toolu_1-0', link: { href: 'file:///C:/work/here' } })
    expect(opened.map(argv => argv[0])).toEqual(['powershell.exe'])
    expect(opened[0]?.[4]).toContain("$p = 'C:\\work\\here'")
    await ui.unmount()
  })

  test(`${surface}: Edit, Write and WebFetch rows draw their target as a link`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const update = await $.ui.mount({ ...row('Edit', { file_path: '/tmp/x.ts', old_string: 'a', new_string: 'b' }), surface })
    expect((await update.find({ type: 'Markdown' }))?.props?.text).toBe('**Update**([/tmp/x\\.ts](file:///tmp/x.ts))')
    await update.unmount()
    const fetch = await $.ui.mount({ ...row('WebFetch', { url: 'https://example.com/a', prompt: 'p' }), surface })
    expect((await fetch.find({ type: 'Markdown' }))?.props?.text).toBe('**Fetch**([https://example\\.com/a](https://example.com/a))')
    await fetch.unmount()
  })

  test(`${surface}: a click on a Read result shows the file and a second one folds it`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const output = { type: 'text', file: { filePath: '/w/a.py', content: 'x = 1\ny = 2\n', numLines: 2, startLine: 3, totalLines: 9 } }
    const result = { tool_use_id: 'toolu_1', tool: 'Read', output, isErrored: false }
    const ui = await $.ui.mount({ plugin: 'shell-highlight', component: 'ToolResult', requestId: 'toolu_1', viewport: VIEWPORT, props: result, surface })
    expect((await ui.find({ type: 'Markdown' }))?.props?.text).toBe('[Read **2** lines](file:///w/a.py)')
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.press({ key: 'read-toolu_1', link: { href: 'file:///w/a.py' } })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'x = 1\ny = 2', path: '/w/a.py', startLine: 3 })
    expect(await ui.find({ text: '(click to fold)' })).toBeDefined()
    await ui.press({ key: 'read-toolu_1', link: { href: 'file:///w/a.py' } })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: a Read row of an unfolded group shows the file without a toggle`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const output = { type: 'text', file: { filePath: '/w/a.py', content: 'x = 1', numLines: 1, startLine: 1, totalLines: 1 } }
    const input = { file_path: '/w/a.py' }
    const unfolded = await $.ui.mount({ ...group([{ tool_use_id: 'toolu_1', tool: 'Read', input, output }], true), surface })
    const ui = await $.ui.mount({ ...row('Read', input, { output }), surface })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'x = 1', path: '/w/a.py' })
    expect(await ui.find({ text: '(click to fold)' })).toBeUndefined()
    await ui.unmount()
    await unfolded.unmount()
  })

  test(`${surface}: outside fullscreen a Read result is plain text`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const output = { type: 'text', file: { filePath: '/w/a.py', content: 'x = 1', numLines: 1, startLine: 1, totalLines: 1 } }
    const result = { tool_use_id: 'toolu_1', tool: 'Read', output, isErrored: false }
    const ui = await $.ui.mount({ plugin: 'shell-highlight', component: 'ToolResult', requestId: 'toolu_1', viewport: { ...VIEWPORT, isFullscreen: false }, props: result, surface })
    expect((await ui.find({ type: 'Markdown' }))?.props?.text).toBe('Read **1** line')
    expect(await ui.find({ text: '(click to show)' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: an unfolded group is the engine's, which draws each call as a row`, async ($, on) => {
    const seen: boolean[] = []
    on('ui.render', ($$, e) => {
      if (e.component === 'ToolGroup') seen.push(e.props.isExpanded)
      return ENGINE_ROW
    })
    const ui = await $.ui.mount({ ...group([SEQ], true), surface })
    expect(seen).toEqual([true])
    expect(await ui.find({ text: 'engine row' })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.unmount()
  })
}
