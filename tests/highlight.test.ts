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

type GroupCall = { tool: string; input: unknown; tool_use_id?: string; output?: unknown; isRunning?: boolean }

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
const TOOL_VIEW = { command: 'tool-view', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as const

type Node = { type: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }

function nodes(tree: unknown): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (tree === null || typeof tree !== 'object') return []
  const node = tree as Node
  return [node, ...nodes(node.children ?? [])]
}

function overlays(tree: unknown): { plain: string; code: unknown; over: Node }[] {
  return nodes(tree).flatMap(node => {
    const [plain, over] = (node.children ?? []) as Node[]
    if (over?.props?.position !== 'absolute') return []
    return [{ plain: String(plain?.children?.[0]), code: nodes(over.children).find(one => one.type === 'Code')?.props?.source, over }]
  })
}

function result(more: Record<string, unknown> = {}) {
  return {
    plugin: 'shell-highlight',
    component: 'ToolResult',
    requestId: 'toolu_1',
    viewport: VIEWPORT,
    props: { tool_use_id: 'toolu_1', tool: 'Bash', output: SEQ.output, isErrored: false, ...more },
  } as const
}

test('terminal: in fullscreen a command is plain, with its coloured copy shown only under the pointer', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  const ui = await $.ui.mount({ ...row('Bash', { command: "node -e 'console.log(1)'" }), surface: 'terminal' })
  await ui.press({ key: 'command-toolu_1' })
  const tree = await ui.drawn()
  const found = overlays(tree)
  expect(found.map(one => one.plain)).toEqual(["node -e '", 'console.log(1)', "'"])
  expect(found.map(one => one.code)).toEqual(found.map(one => one.plain))
  for (const one of found) {
    expect(one.over.props).toMatchObject({ position: 'absolute', top: 0, left: 0, right: 0, display: 'none' })
    expect(one.over.hover).toEqual({ display: 'flex' })
  }
  expect(nodes(tree).find(node => node.props?.key === 'call-toolu_1')).toBeDefined()
  await ui.unmount()
})

test('terminal: a path in a command stays a link outside the coloured copy', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  const ui = await $.ui.mount({ ...row('PowerShell', { command: 'node "C:\\a\\run.mjs"' }), surface: 'terminal' })
  await ui.press({ key: 'command-toolu_1' })
  const tree = await ui.drawn()
  expect(overlays(tree).map(one => one.plain)).toEqual(['node "', '"'])
  const over = overlays(tree).flatMap(one => nodes(one.over))
  expect(over.some(node => node.type === 'Markdown')).toBe(false)
  expect(await ui.find({ type: 'Markdown', key: 'link-toolu_1-0' })).toBeDefined()
  await ui.unmount()
})

test('terminal: a command too long to draw twice is coloured at once', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  const ui = await $.ui.mount({ ...row('Bash', { command: `echo ${'x '.repeat(30000)}` }, { isExpanded: true }), surface: 'terminal' })
  expect(overlays(await ui.drawn())).toEqual([])
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  await ui.unmount()
})

test('terminal: a command that fits twice into a drawing keeps its coloured copy', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  const ui = await $.ui.mount({ ...row('Bash', { command: `echo ${'x '.repeat(20000)}` }, { isExpanded: true }), surface: 'terminal' })
  expect(overlays(await ui.drawn()).length).toBeGreaterThan(0)
  await ui.unmount()
})

test('terminal: keys count against the drawing, so a copy that fits only without them is left out', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  const ui = await $.ui.mount({ ...row('Bash', { command: `echo ${'x '.repeat(24734)}` }, { isExpanded: true }), surface: 'terminal' })
  expect(overlays(await ui.drawn())).toEqual([])
  await ui.unmount()
})

test('terminal: a command of many pieces is coloured at once when its copies would pass the node limit', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  const command = "node -e 'a'; ".repeat(2400).trim()
  const ui = await $.ui.mount({ ...row('Bash', { command }, { isExpanded: true }), surface: 'terminal' })
  const tree = await ui.drawn()
  expect(overlays(tree)).toEqual([])
  expect(nodes(tree).length).toBeLessThanOrEqual(20000)
  expect((await ui.findAll({ type: 'Code' })).length).toBeGreaterThan(0)
  await ui.unmount()
})

test('terminal: a command one step inside the drawing keeps its coloured copy, one step past it is coloured at once', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  const inside = await $.ui.mount({ ...row('Bash', { command: `echo ${'x '.repeat(24691)}` }, { isExpanded: true }), surface: 'terminal' })
  expect(overlays(await inside.drawn()).length).toBeGreaterThan(0)
  expect(await inside.find({ type: 'Code' })).toBeDefined()
  await inside.unmount()
  const past = await $.ui.mount({ ...row('Bash', { command: `echo ${'x '.repeat(24692)}` }, { isExpanded: true }), surface: 'terminal' })
  expect(overlays(await past.drawn())).toEqual([])
  expect(await past.find({ type: 'Code' })).toBeDefined()
  await past.unmount()
})

test('terminal: the props of many pieces count against the drawing, one step inside or past it', async ($, on) => {
  on('ui.render', () => ENGINE_ROW)
  const inside = await $.ui.mount({ ...row('Bash', { command: "node -e 'a'; ".repeat(926).trim() }, { isExpanded: true }), surface: 'terminal' })
  expect(overlays(await inside.drawn()).length).toBeGreaterThan(0)
  expect(await inside.find({ type: 'Code' })).toBeDefined()
  await inside.unmount()
  const past = await $.ui.mount({ ...row('Bash', { command: "node -e 'a'; ".repeat(927).trim() }, { isExpanded: true }), surface: 'terminal' })
  expect(overlays(await past.drawn())).toEqual([])
  expect(await past.find({ type: 'Code' })).toBeDefined()
  await past.unmount()
})

for (const [name, surface, viewport] of [
  ['terminal main screen', 'terminal', { ...VIEWPORT, isFullscreen: false }],
  ['desktop', 'desktop', VIEWPORT],
] as const) {
  test(`${name}: without a pointer the command is coloured at once`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('Bash', { command: 'ls -la' }), viewport, surface })
    if (viewport.isFullscreen) await ui.press({ key: 'command-toolu_1' })
    expect(overlays(await ui.drawn())).toEqual([])
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'ls -la' })
    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a Bash command is drawn as highlighted code`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('Bash', { command: 'cd ~/.claude && ls -la', description: 'List' }), surface })
    await ui.press({ key: 'command-toolu_1' })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'cd ~/.claude && ls -la', language: 'bash' })
    expect(await ui.find({ text: 'List' })).toBeDefined()
    expect(await ui.find({ text: 'engine row' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: a PowerShell command is drawn as highlighted code`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('PowerShell', { command: 'Get-ChildItem -Force' }), surface })
    await ui.press({ key: 'command-toolu_1' })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ language: 'powershell' })
    await ui.unmount()
  })

  test(`${surface}: an embedded script is highlighted in its own language`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const command = "node <<'EOF'\nconsole.log(1)\nEOF"
    const ui = await $.ui.mount({ ...row('Bash', { command }), surface })
    await ui.press({ key: 'command-toolu_1' })
    const languages = (await ui.findAll({ type: 'Code' })).map(code => code.props?.language)
    expect(languages).toEqual(['bash', 'javascript', 'bash'])
    await ui.unmount()
  })

  test(`${surface}: a command with control characters is still drawn`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('Bash', { command: 'printf "\u001b[31mred"' }), surface })
    await ui.press({ key: 'command-toolu_1' })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'printf "␛[31mred"' })
    await ui.unmount()
  })

  test(`${surface}: a command longer than one element is drawn in several`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const command = Array.from({ length: 8 }, (_, n) => `echo ${'x'.repeat(3000)}${n}`).join('\n')
    const ui = await $.ui.mount({ ...row('Bash', { command }), surface })
    await ui.press({ key: 'command-toolu_1' })
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
    await ui.press({ key: 'command-toolu_1' })
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
    await ui.press({ key: 'command-toolu_1' })
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

  test(`${surface}: a row drawn on its own before its run unfolds is drawn again with its output`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const alone = await $.ui.mount({ ...row('Bash', SEQ.input, { output: SEQ.output, isExpanded: true }), surface })
    const block = await $.ui.mount({ ...result({ isExpanded: true }), surface })
    expect(await alone.find({ text: 'line 1' })).toBeUndefined()
    expect(await block.find({ text: 'engine row' })).toBeDefined()
    const unfolded = await $.ui.mount({ ...group([SEQ], true), surface })
    expect(await alone.find({ text: 'line 1' })).toBeDefined()
    expect(await block.find({ text: 'engine row' })).toBeUndefined()
    await unfolded.unmount()
    await block.unmount()
    await alone.unmount()
  })

  test(`${surface}: in the ctrl+o transcript the result of another tool of an unfolded run stays the engine's`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const glob = { tool_use_id: 'toolu_3', tool: 'Glob', input: { pattern: '*.txt' }, output: { filenames: ['a.txt'] } }
    const unfolded = await $.ui.mount({ ...group([glob, SEQ], true), surface })
    const globBlock = await $.ui.mount({ ...result({ tool_use_id: 'toolu_3', tool: 'Glob', output: glob.output, isExpanded: true }), requestId: 'toolu_3', surface })
    expect(await globBlock.find({ text: 'engine row' })).toBeDefined()
    await globBlock.unmount()
    const shellBlock = await $.ui.mount({ ...result({ isExpanded: true }), surface })
    expect(await shellBlock.find({ text: 'engine row' })).toBeUndefined()
    await shellBlock.unmount()
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

  test(`${surface}: a folded group of shell calls hides the commands and shows the start of the output`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...group([SEQ]), surface })
    expect(await ui.find({ text: 'engine row' })).toBeUndefined()
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ text: 'line 5' })).toBeDefined()
    expect(await ui.find({ text: 'line 6' })).toBeUndefined()
    expect(await ui.find({ text: '… +4 lines (click to expand)' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a folded group counts the lines of a hidden command`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...group([LONG]), surface })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ text: '… +14 lines (click to expand)' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a folded group shows up to 5 lines of output and counts the rest with the command`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    for (const [count, hint] of [[5, '… +1 line (click to expand)'], [6, '… +2 lines (click to expand)'], [7, '… +3 lines (click to expand)']] as const) {
      const stdout = Array.from({ length: count }, (_, n) => `line ${n + 1}`).join('\n')
      const ui = await $.ui.mount({ ...group([{ tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'seq 1 9' }, output: { stdout, stderr: '' } }]), surface })
      expect(await ui.find({ text: 'line 5' })).toBeDefined()
      expect(await ui.find({ text: 'line 6' })).toBeUndefined()
      expect(await ui.find({ text: hint })).toBeDefined()
      await ui.unmount()
    }
  })

  test(`${surface}: a folded group counts a one-line command as one line`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...group([{ tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'true' }, output: { stdout: 'ok', stderr: '' } }]), surface })
    expect(await ui.find({ text: 'ok' })).toBeDefined()
    expect(await ui.find({ text: '… +1 line (click to expand)' })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: in fullscreen a row on its own hides the command until clicked`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const ui = await $.ui.mount({ ...row('Bash', { ...SEQ.input, description: 'Count' }), surface })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ text: 'Count' })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'command-toolu_1' }))?.props).toMatchObject({ label: '(click to show)', plain: true, dimColor: true })
    await ui.press({ key: 'command-toolu_1' })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'seq 1 8' })
    expect((await ui.find({ type: 'Button', key: 'command-toolu_1' }))?.props.label).toBe('(click to fold)')
    await ui.press({ key: 'command-toolu_1' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: a row of an unfolded group shows its command without a toggle`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const unfolded = await $.ui.mount({ ...group([SEQ], true), surface })
    const ui = await $.ui.mount({ ...row('Bash', SEQ.input, { output: SEQ.output }), surface })
    expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'seq 1 8' })
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
    await unfolded.unmount()
  })

  test(`${surface}: outside fullscreen and in the ctrl+o transcript a row on its own shows its command without a toggle`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const classic = await $.ui.mount({ ...row('Bash', SEQ.input), viewport: { ...VIEWPORT, isFullscreen: false }, surface })
    expect((await classic.find({ type: 'Code' }))?.props).toMatchObject({ source: 'seq 1 8' })
    expect(await classic.find({ type: 'Button' })).toBeUndefined()
    await classic.unmount()
    const transcript = await $.ui.mount({ ...row('Bash', SEQ.input, { isExpanded: true }), surface })
    expect((await transcript.find({ type: 'Code' }))?.props).toMatchObject({ source: 'seq 1 8' })
    expect(await transcript.find({ type: 'Button' })).toBeUndefined()
    await transcript.unmount()
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
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ text: '… +4 lines (click to expand)' })).toBeDefined()
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
    await ui.press({ key: 'command-toolu_1' })
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
    await ui.press({ key: 'command-toolu_1' })
    await ui.press({ key: 'link-toolu_1-0', link: { href: 'file:///C:/work/here' } })
    expect(opened.map(argv => argv[0])).toEqual(['powershell.exe'])
    expect(opened[0]?.[4]).toContain("$p = 'C:\\work\\here'")
    await ui.unmount()
  })

  test(`${surface}: an opener that exits with an error hands the path to the next one`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const toasts: string[] = []
    on('ui.toast', ($$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    const opened: string[] = []
    const exits: Record<string, number | undefined> = { 'xdg-open': 3, open: 0 }
    on('process.run', ($$, e) => {
      const opener = e.argv[0] ?? ''
      opened.push(opener)
      const exitCode = exits[opener]
      if (exitCode === undefined) return { deny: 'not found' }
      return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const ui = await $.ui.mount({ ...row('Edit', { file_path: '/tmp/x.ts', old_string: 'a', new_string: 'b' }), surface })
    await ui.press({ key: 'path-toolu_1', link: { href: 'file:///tmp/x.ts' } })
    expect(opened).toEqual(['xdg-open', 'open'])
    expect(toasts).toEqual(['Opening /tmp/x.ts'])
    exits['open'] = 1
    opened.length = 0
    await ui.press({ key: 'path-toolu_1', link: { href: 'file:///tmp/x.ts' } })
    expect(opened).toEqual(['xdg-open', 'open', 'explorer.exe'])
    expect(toasts).toEqual(['Opening /tmp/x.ts', 'Could not open /tmp/x.ts'])
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
    expect(seen).toEqual([true, true])
    expect(await ui.find({ text: 'engine row' })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: /tool-view and the footer button cycle full, one line and off`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    const footer = await $.ui.mount({ plugin: 'shell-highlight', component: 'PromptHint', requestId: 'hint', viewport: VIEWPORT, props: { isDraft: false, isWorking: false, hint: '' }, surface })
    const label = async () => (await footer.find({ type: 'Button', key: 'tool-view' }))?.props.label
    expect(await label()).toBe('🔧 tools: full')
    expect(await $.command.run(TOOL_VIEW)).toEqual({})
    expect(await label()).toBe('🔧 tools: one line')
    await footer.press({ key: 'tool-view' })
    expect(await label()).toBe('🔧 tools: off')
    await footer.press({ key: 'tool-view' })
    expect(await label()).toBe('🔧 tools: full')
    await footer.unmount()
  })

  test(`${surface}: the footer button sits after what is drawn beneath it`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    for (const isWorking of [true, false]) {
      const footer = await $.ui.mount({ plugin: 'shell-highlight', component: 'PromptHint', requestId: 'hint', viewport: VIEWPORT, props: { isDraft: false, isWorking, hint: '' }, surface })
      expect(await footer.find({ text: 'engine row' })).toBeDefined()
      expect(await footer.find({ type: 'Button', key: 'tool-view' })).toBeDefined()
      await footer.unmount()
    }
  })

  test(`${surface}: a group unfolded by a click follows the view, the classic ctrl+o transcript does not`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    await $.command.run(TOOL_VIEW)
    await $.command.run(TOOL_VIEW)
    const clicked = await $.ui.mount({ ...group([READ, SEQ], true), surface })
    expect(await clicked.find({ text: 'engine row' })).toBeUndefined()
    expect(await clicked.find({ type: 'Text' })).toBeUndefined()
    await clicked.unmount()
    const transcript = await $.ui.mount({ ...group([READ, SEQ], true), viewport: { ...VIEWPORT, isFullscreen: false }, surface })
    expect(await transcript.find({ text: 'engine row' })).toBeDefined()
    await transcript.unmount()
  })

  test(`${surface}: in the one-line view every call is one line and no result is drawn`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    await $.command.run(TOOL_VIEW)
    const bash = await $.ui.mount({ ...row('Bash', { command: 'seq 1 8', description: 'Count' }, { output: SEQ.output }), surface })
    expect(await bash.find({ type: 'Code' })).toBeUndefined()
    expect(await bash.find({ text: 'Bash' })).toBeDefined()
    expect(await bash.find({ text: 'Count' })).toBeDefined()
    expect(await bash.find({ text: 'line 1' })).toBeUndefined()
    await bash.unmount()
    const glob = await $.ui.mount({ ...row('Glob', { pattern: '*.md' }), surface })
    expect(await glob.find({ text: 'engine row' })).toBeUndefined()
    expect(await glob.find({ text: 'Glob' })).toBeDefined()
    expect(await glob.find({ text: '*.md' })).toBeDefined()
    await glob.unmount()
    const read = await $.ui.mount({ ...row('Read', { file_path: 'README.md', offset: 3 }), surface })
    expect(await read.find({ text: 'README.md · from line 3' })).toBeDefined()
    await read.unmount()
    const block = await $.ui.mount({ ...result(), surface })
    expect(await block.find({ type: 'Text' })).toBeUndefined()
    await block.unmount()
    const folded = await $.ui.mount({ ...group([READ, SEQ]), surface })
    expect(await folded.find({ text: 'engine row' })).toBeUndefined()
    expect(await folded.find({ text: 'README.md' })).toBeDefined()
    expect(await folded.find({ text: 'seq 1 8' })).toBeDefined()
    expect(await folded.find({ type: 'Code' })).toBeUndefined()
    await folded.unmount()
  })

  test(`${surface}: in the off view a finished call draws nothing and a running one keeps its line`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    await $.command.run(TOOL_VIEW)
    await $.command.run(TOOL_VIEW)
    const done = await $.ui.mount({ ...row('Read', { file_path: 'README.md' }), surface })
    expect(await done.find({ type: 'Text' })).toBeUndefined()
    await done.redraw({ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'README.md' }, ...DONE, isRunning: true })
    expect(await done.find({ text: 'README.md' })).toBeDefined()
    await done.unmount()
    const block = await $.ui.mount({ ...result(), surface })
    expect(await block.find({ type: 'Text' })).toBeUndefined()
    await block.unmount()
    const folded = await $.ui.mount({ ...group([READ, { ...SEQ, output: undefined, isRunning: true }]), surface })
    expect(await folded.find({ text: 'README.md' })).toBeUndefined()
    expect(await folded.find({ text: 'seq 1 8' })).toBeDefined()
    await folded.unmount()
  })

  test(`${surface}: the full transcript still shows every call in full in the other views`, async ($, on) => {
    on('ui.render', () => ENGINE_ROW)
    await $.command.run(TOOL_VIEW)
    await $.command.run(TOOL_VIEW)
    const bash = await $.ui.mount({ ...row('Bash', SEQ.input, { isExpanded: true }), surface })
    expect((await bash.find({ type: 'Code' }))?.props).toMatchObject({ source: 'seq 1 8' })
    await bash.unmount()
    const glob = await $.ui.mount({ ...row('Glob', { pattern: '*.md' }, { isExpanded: true }), surface })
    expect(await glob.find({ text: 'engine row' })).toBeDefined()
    await glob.unmount()
    const block = await $.ui.mount({ ...result({ isExpanded: true }), surface })
    expect(await block.find({ text: 'engine row' })).toBeDefined()
    await block.unmount()
  })
}
