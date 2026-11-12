import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import { cells, chunks, escapeMarkdown, fromLinkTarget, isWindowsPath, layout, lineCount, linkify, linkRows, linkTarget, outputLines, sniffLanguage, takeLines, visible } from './text'
import type { Links, Piece, Shell } from './text'
import type { ToolView } from '../types'

const SHELLS: Record<string, Shell> = { Bash: 'bash', PowerShell: 'powershell' }
const PATH_TOOLS: Record<string, { label: string; field: string }> = {
  Read: { label: 'Read', field: 'file_path' },
  Edit: { label: 'Update', field: 'file_path' },
  Write: { label: 'Write', field: 'file_path' },
  WebFetch: { label: 'Fetch', field: 'url' },
}
const FOLDED_COMMAND_LINES = 10
const FOLDED_OUTPUT_LINES = 5
const FOLD_SLACK = 1
const DIM = 'inactive'
const LIT = { color: 'text' }
const VIEWS: ToolView[] = ['full', 'line', 'off']
const VIEW_LABELS: Record<ToolView, string> = { full: 'tools: full', line: 'tools: one line', off: 'tools: off' }
const VIEW_COMMAND = 'tool-view'
const SUMMARY_FIELDS = ['description', 'pattern', 'query', 'url', 'path', 'skill', 'prompt']
// A drawing shows its first 100,000 characters and is refused past 20,000 nodes; the hover draws a command twice.
const DRAWING_MAX_CHARS = 100000
const DRAWING_MAX_NODES = 20000

const groupRows = new Set<string>()
const shown = atom({ plugin: 'shell-highlight', key: 'shown' } as const, [] as string[])
const view = atom({ plugin: 'shell-highlight', key: 'view' } as const, 'full' as ToolView)
let home: string | undefined

function links(): Links {
  return home === undefined ? {} : { home }
}

type RenderEvent = Parameters<EngineInterface['ui']['resolve']>[0]

type Call = {
  id: string
  tool: string
  input: unknown
  isRunning: boolean
  isErrored: boolean
  isInterrupted: boolean
  output?: unknown
}

type ShellCommand = { shell: Shell; command: string; description: string }

function shellCommand(tool: string, input: unknown): ShellCommand | undefined {
  const shell = SHELLS[tool]
  const fields = input as { command?: unknown; description?: unknown } | null
  if (shell === undefined || typeof fields?.command !== 'string') return undefined
  const command = visible(fields.command).replace(/\n+$/, '')
  if (command.trim() === '') return undefined
  return { shell, command, description: typeof fields.description === 'string' ? fields.description : '' }
}

function draw(
  $: EngineInterface,
  e: RenderEvent,
  call: Call,
  shown: ShellCommand,
  isFolded: boolean,
  hasOutput: boolean,
  viewport: { columns: number; isFullscreen?: boolean } | undefined,
  hasHover: boolean,
) {
  const { Box, Text, Code, Markdown } = $.ui.resolve(e)
  const isHover = hasHover && e.surface === 'terminal' && viewport?.isFullscreen === true
  const columns = Math.max(20, (viewport?.columns ?? 80) - 6)
  const code = (piece: Piece, source: string) => {
    const lit = Code({ source, ...(piece.language !== undefined ? { language: piece.language } : {}), ...(piece.path !== undefined ? { path: piece.path } : {}) })
    if (!isHover) return lit
    // A hover can reveal a Box but never hide one, so the coloured copy lies absolutely over the plain one.
    return Box({
      children: [
        Text({ color: DIM, children: [source] }),
        Box({ position: 'absolute', top: 0, left: 0, right: 0, display: 'none', hover: { display: 'flex' }, children: [lit] }),
      ],
    })
  }
  const dim = (text: string) => Text({ color: DIM, hover: LIT, children: [text] })
  let linkCount = 0
  const cell = (piece: Piece, drawn: (piece: Piece) => ReturnType<typeof Text>) => {
    const target = piece.link
    return Box({
      flexShrink: 0,
      flexGrow: 0,
      width: cells(piece.source),
      children: [
        target === undefined
          ? drawn(piece)
          : Markdown({
              key: `link-${call.id}-${linkCount++}`,
              text: `[${escapeMarkdown(piece.source)}](${linkTarget(target)})`,
              onLinkPress: () => void openTarget($, target),
            }),
      ],
    })
  }

  const header = [
    Box({
      flexDirection: 'row',
      gap: 1,
      flexShrink: 0,
      children: [
        Text({
          color: call.isRunning ? DIM : call.isErrored || call.isInterrupted ? 'error' : 'success',
          children: ['●'],
        }),
        Text({ bold: true, children: [call.tool] }),
      ],
    }),
  ]
  if (shown.description !== '') header.push(dim(shown.description))
  if (call.isInterrupted) header.push(dim('Interrupted'))

  const blocks = layout(shown.command, shown.shell, columns, links())
  const commandLines = lineCount(blocks)
  const isCommandCut = isFolded && commandLines > FOLDED_COMMAND_LINES + FOLD_SLACK
  const body = []
  const drawn = isCommandCut ? takeLines(blocks, FOLDED_COMMAND_LINES) : blocks
  for (const block of drawn) {
    if (block.kind === 'row') {
      body.push(Box({ flexDirection: 'row', children: block.pieces.map(piece => cell(piece, one => code(one, one.source))) }))
    } else {
      for (const source of chunks(block.piece.source)) body.push(code(block.piece, source))
    }
  }
  let hidden = isCommandCut ? commandLines - FOLDED_COMMAND_LINES : 0
  if (hidden > 0) body.push(dim('…'))

  const result = []
  const lines = hasOutput ? outputLines(call.output) : []
  const isOutputCut = isFolded && lines.length > FOLDED_OUTPUT_LINES + FOLD_SLACK
  const visibleLines = isOutputCut ? lines.slice(0, FOLDED_OUTPUT_LINES) : lines
  hidden += lines.length - visibleLines.length
  if (call.isRunning) result.push(dim('Running…'))
  else if (lines.length > 0) {
    let plain: string[] = []
    const flush = () => {
      if (plain.length > 0) for (const text of chunks(plain.join('\n'))) result.push(dim(text))
      plain = []
    }
    for (const line of visibleLines) {
      const rows = linkRows(line, columns - 2, links())
      if (rows === undefined) {
        plain.push(line)
        continue
      }
      flush()
      for (const pieces of rows) result.push(Box({ flexDirection: 'row', children: pieces.map(piece => cell(piece, one => dim(one.source))) }))
    }
    flush()
  } else if (hasOutput && call.output !== undefined) result.push(dim('(no output)'))
  if (hidden > 0) result.push(dim(`… +${hidden} lines (${viewport?.isFullscreen === true ? 'click' : 'ctrl+o'} to expand)`))

  if (result.length > 0) {
    body.push(
      Box({
        flexDirection: 'row',
        gap: 1,
        children: [Box({ flexShrink: 0, children: [dim('⎿')] }), Box({ flexDirection: 'column', children: result })],
      }),
    )
  }

  return Box({
    key: `call-${call.id}`,
    flexDirection: 'column',
    marginTop: 1,
    children: [
      Box({ flexDirection: 'row', gap: 1, children: header }),
      Box({ flexDirection: 'column', paddingLeft: 2, children: body }),
    ],
  })
}

function stringLength(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (value === null || typeof value !== 'object') return 0
  return Object.values(value).reduce<number>((sum, one) => sum + stringLength(one), 0)
}

// Every string counts, props too, nested ones included (a Select's options from a mod beneath):
// the engine counts keys as well as text, so this errs on the safe side.
function treeSize(node: unknown): { chars: number; nodes: number } {
  if (typeof node === 'string') return { chars: node.length, nodes: 1 }
  if (node === null || typeof node !== 'object') return { chars: 0, nodes: 0 }
  const element = node as { props?: Record<string, unknown>; children?: unknown[] }
  const own = stringLength(element.props)
  return (element.children ?? []).reduce<{ chars: number; nodes: number }>(
    (total, child) => {
      const one = treeSize(child)
      return { chars: total.chars + one.chars, nodes: total.nodes + one.nodes }
    },
    { chars: own, nodes: 1 },
  )
}

function withinBudget(drawing: (hasHover: boolean) => RenderElement): RenderElement {
  const lit = drawing(true)
  const size = treeSize(lit)
  return size.chars <= DRAWING_MAX_CHARS && size.nodes <= DRAWING_MAX_NODES ? lit : drawing(false)
}

type PathTarget = { label: string; target: string; detail: string }

type ReadFile = { filePath: string; content: string; numLines: number; startLine: number }

function pathTarget(tool: string, input: unknown): PathTarget | undefined {
  const known = PATH_TOOLS[tool]
  const fields = input as Record<string, unknown> | null
  const target = fields?.[known?.field ?? '']
  if (known === undefined || typeof target !== 'string' || target.trim() === '') return undefined
  let detail = ''
  if (tool === 'Read') {
    const offset = typeof fields?.offset === 'number' ? fields.offset : undefined
    const limit = typeof fields?.limit === 'number' ? fields.limit : undefined
    if (limit !== undefined) detail = ` · lines ${offset ?? 1}-${(offset ?? 1) + limit - 1}`
    else if (offset !== undefined) detail = ` · from line ${offset}`
    if (typeof fields?.pages === 'string') detail += ` · pages ${fields.pages}`
  }
  return { label: known.label, target, detail }
}

function readFile(output: unknown): ReadFile | undefined {
  const result = output as { type?: unknown; file?: Partial<ReadFile> } | null
  const file = result?.file
  if (result?.type !== 'text' || typeof file?.filePath !== 'string' || typeof file.content !== 'string') return undefined
  return {
    filePath: file.filePath,
    content: file.content,
    numLines: typeof file.numLines === 'number' ? file.numLines : file.content.split('\n').length,
    startLine: typeof file.startLine === 'number' ? file.startLine : 1,
  }
}

function foregroundFolder(path: string): string {
  return `$p = '${path.replace(/'/g, "''")}'
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, int f, System.UIntPtr e); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);'
$url = ([System.Uri]$p).AbsoluteUri
$sh = New-Object -ComObject Shell.Application
$known = @($sh.Windows() | ForEach-Object { $_.HWND })
$sh.Open($p)
foreach ($i in 1..50) {
  Start-Sleep -Milliseconds 100
  $w = $sh.Windows() | Where-Object { $_.LocationURL -eq $url -and $known -notcontains $_.HWND } | Select-Object -First 1
  if ($w) {
    [W.U]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W.U]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][W.U]::ShowWindow([IntPtr]$w.HWND, 9); [void][W.U]::SetForegroundWindow([IntPtr]$w.HWND)
    break
  }
}`
}

async function openTarget($: EngineInterface, target: string) {
  const isUrl = /^https?:\/\//i.test(target)
  const local = isWindowsPath(target) ? target.replace(/\//g, '\\') : target
  if (isWindowsPath(local) && (await $.fs.stat(local).catch(() => undefined))?.kind === 'dir') {
    try {
      await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', foregroundFolder(local)])
      $.ui.toast(`Opening ${local}`)
      return
    } catch {}
  }
  const openers = isUrl || isWindowsPath(target) ? ['explorer.exe', 'xdg-open', 'open'] : ['xdg-open', 'open', 'explorer.exe']
  for (const opener of openers) {
    try {
      await $.process.run([opener, local])
      $.ui.toast(`Opening ${local}`)
      return
    } catch {}
  }
  $.ui.toast(`Could not open ${target}`)
}

function drawPathHeader($: EngineInterface, e: RenderEvent, call: Call, path: PathTarget) {
  const { Box, Text, Markdown } = $.ui.resolve(e)
  const href = linkTarget(path.target)
  const children = [
    Box({
      flexShrink: 0,
      children: [
        Text({
          color: call.isRunning ? DIM : call.isErrored || call.isInterrupted ? 'error' : 'success',
          children: ['●'],
        }),
      ],
    }),
    Markdown({
      key: `path-${call.id}`,
      text: `**${path.label}**([${escapeMarkdown(path.target)}](${href})${escapeMarkdown(path.detail)})`,
      onLinkPress: () => void openTarget($, path.target),
    }),
  ]
  if (call.isInterrupted) children.push(Text({ color: DIM, children: ['Interrupted'] }))
  return Box({ key: `head-${call.id}`, flexDirection: 'row', gap: 1, marginTop: 1, children })
}

function drawReadResult($: EngineInterface, e: RenderEvent, id: string, file: ReadFile, isOpen: boolean, isClickable: boolean) {
  const { Box, Text, Markdown, Code } = $.ui.resolve(e)
  const href = linkTarget(file.filePath)
  const count = `Read **${file.numLines}** ${file.numLines === 1 ? 'line' : 'lines'}`
  const summary = [
    Markdown({
      key: `read-${id}`,
      text: isClickable ? `[${count}](${href})` : count,
      ...(isClickable
        ? {
            onLinkPress: () =>
              void update($, shown, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id])),
          }
        : {}),
    }),
  ]
  if (isClickable) summary.push(Text({ color: DIM, hover: LIT, children: [isOpen ? '(click to fold)' : '(click to show)'] }))

  const lines = [Box({ flexDirection: 'row', gap: 1, children: summary })]
  if (isOpen) {
    const language = sniffLanguage(file.filePath, file.content)
    let startLine = file.startLine
    for (const source of chunks(visible(file.content).replace(/\n$/, ''))) {
      lines.push(Code({ source, ...(language !== undefined ? { language } : { path: file.filePath }), startLine }))
      startLine += source.split('\n').length
    }
  }
  return Box({
    key: `result-${id}`,
    flexDirection: 'row',
    gap: 1,
    children: [Box({ flexShrink: 0, children: [Text({ color: DIM, children: ['⎿'] })] }), Box({ flexDirection: 'column', children: lines })],
  })
}

function drawLine($: EngineInterface, e: RenderEvent, call: Call) {
  const { Box, Text } = $.ui.resolve(e)
  const shell = shellCommand(call.tool, call.input)
  const path = pathTarget(call.tool, call.input)
  const fields = typeof call.input === 'object' && call.input !== null ? (call.input as Record<string, unknown>) : {}
  const named = [...SUMMARY_FIELDS.map(field => fields[field]), ...Object.values(fields)].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  )
  const text = shell !== undefined ? shell.description || shell.command : path !== undefined ? path.target + path.detail : (named ?? '')
  const summary = visible(text.replace(/\s+/g, ' ').trim()).slice(0, 500)
  const children = [
    Box({
      flexDirection: 'row',
      gap: 1,
      flexShrink: 0,
      children: [
        Text({
          color: call.isRunning ? DIM : call.isErrored || call.isInterrupted ? 'error' : 'success',
          children: ['●'],
        }),
        Text({ bold: true, children: [path?.label ?? call.tool] }),
      ],
    }),
  ]
  if (summary !== '') children.push(Text({ color: DIM, wrap: 'truncate-end', children: [summary] }))
  return Box({ flexDirection: 'row', gap: 1, children })
}

function nextView(current: ToolView): ToolView {
  return VIEWS[(VIEWS.indexOf(current) + 1) % VIEWS.length] ?? 'full'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    await $.command
      .register({ name: VIEW_COMMAND, description: 'Cycle how tool calls are drawn: full, one line, off', immediate: true })
      .catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: VIEW_COMMAND }, async $ => {
    const current = await update($, view, nextView)
    $.ui.toast(VIEW_LABELS[current])
    return {}
  }).catch(($, e, next) => ({ text: `/${VIEW_COMMAND} failed: ${next.error.message}` }))

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const current = await read($, view)
    const { Box, Button } = $.ui.resolve(e)
    const button = Button({
      key: 'tool-view',
      label: `🔧 ${VIEW_LABELS[current]}`,
      plain: true,
      dimColor: true,
      onPress: () => void update($, view, nextView),
    })
    return Box({ flexDirection: 'row', children: [await next(e), button] })
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    const text = linkify(e.props.text, links())
    if (text === e.props.text) return next(e)
    if ((e.props as { isSummary?: true }).isSummary === true) return next({ ...e, props: { ...e.props, text } })
    const { Box, Text, Markdown } = $.ui.resolve(e)
    return Box({
      flexDirection: 'row',
      marginTop: 1,
      children: [
        Box({ flexShrink: 0, width: 2, children: [Text({ children: [e.props.isFirstOfReply ? '●' : ' '] })] }),
        Markdown({
          key: `reply-${String(e.requestId)}`,
          text,
          onLinkPress: link => void openTarget($, fromLinkTarget(link.href)),
        }),
      ],
    })
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const current = await read($, view)
    // In fullscreen a click unfolds a group; the ctrl+o transcript there draws no groups at all.
    const isCompact = current !== 'full' && (!e.props.isExpanded || e.viewport?.isFullscreen === true)
    if (e.props.isExpanded && !isCompact) {
      for (const call of e.props.calls) if (call.tool_use_id !== undefined) groupRows.add(call.tool_use_id)
      return next(e)
    }
    const calls = e.props.calls.map((call, index) => ({
      call: { ...call, id: call.tool_use_id ?? `${String(e.requestId)}-${index}` },
      shown: shellCommand(call.tool, call.input),
    }))
    if (isCompact) {
      const { Box } = $.ui.resolve(e)
      const kept = calls.filter(one => current === 'line' || one.call.isRunning)
      return Box({ flexDirection: 'column', children: kept.map(one => drawLine($, e, one.call)) })
    }
    const shellCalls = calls.filter(one => one.shown !== undefined)
    if (shellCalls.length === 0) return next(e)

    const { Box } = $.ui.resolve(e)
    const engineRows = shellCalls.length === calls.length ? [] : [await next(e)]
    return withinBudget(hasHover =>
      Box({
        flexDirection: 'column',
        children: [
          ...engineRows,
          ...shellCalls.flatMap(one => (one.shown === undefined ? [] : [draw($, e, one.call, one.shown, true, true, e.viewport, hasHover)])),
        ],
      }),
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const current = await read($, view)
    const call = { ...e.props, id: e.props.tool_use_id }
    if (current !== 'full' && e.props.isExpanded !== true) {
      if (current === 'line' || call.isRunning) return drawLine($, e, call)
      const { Box } = $.ui.resolve(e)
      return Box({ children: [] })
    }
    const command = shellCommand(e.props.tool, e.props.input)
    if (command !== undefined) return withinBudget(hasHover => draw($, e, call, command, false, groupRows.has(call.id), e.viewport, hasHover))

    const path = pathTarget(e.props.tool, e.props.input)
    const isGroupRow = groupRows.has(call.id)
    if (path === undefined || (isGroupRow && e.props.tool !== 'Read')) return next(e)
    const header = drawPathHeader($, e, call, path)
    const file = isGroupRow ? readFile(e.props.output) : undefined
    if (file === undefined) return header
    const { Box } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [header, drawReadResult($, e, call.id, file, true, false)] })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const current = await read($, view)
    if (groupRows.has(e.props.tool_use_id) || (current !== 'full' && e.props.isExpanded !== true)) {
      const { Box } = $.ui.resolve(e)
      return Box({ children: [] })
    }
    const file = e.props.tool === 'Read' && !e.props.isErrored ? readFile(e.props.output) : undefined
    if (file === undefined) return next(e)
    const isOpen = (await read($, shown)).includes(e.props.tool_use_id)
    return drawReadResult($, e, e.props.tool_use_id, file, isOpen, e.viewport?.isFullscreen === true)
  })
}
