import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { chunks, layout, lineCount, outputLines, takeLines, visible } from './text'
import type { Piece, Shell } from './text'

const SHELLS: Record<string, Shell> = { Bash: 'bash', PowerShell: 'powershell' }
const FOLDED_COMMAND_LINES = 10
const FOLDED_OUTPUT_LINES = 5
const FOLD_SLACK = 1
const STORED_CALLS = 500
const DIM = 'inactive'
const LIT = { color: 'text' }

const expanded = atom({ plugin: 'shell-highlight', key: 'expanded' } as const, [])
const drawnRows = new Set<string>()

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

async function loadExpanded($: EngineInterface) {
  const stored = await $.store.get('expanded').catch(() => undefined)
  const ids = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
  await update($, expanded, () => ids)
}

async function toggle($: EngineInterface, id: string) {
  const ids = await read($, expanded)
  const next = ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id].slice(-STORED_CALLS)
  await update($, expanded, () => next)
  await $.store.set('expanded', next).catch(() => undefined)
}

function draw(
  $: EngineInterface,
  e: RenderEvent,
  call: Call,
  shown: ShellCommand,
  expandedIds: readonly string[] | undefined,
  viewportColumns: number | undefined,
) {
  const { Box, Text, Code, Button } = $.ui.resolve(e)
  const isExpanded = expandedIds?.includes(call.id) === true
  const columns = Math.max(20, (viewportColumns ?? 80) - 6)
  const code = (piece: Piece, source: string) =>
    Code({ source, ...(piece.language !== undefined ? { language: piece.language } : {}), ...(piece.path !== undefined ? { path: piece.path } : {}) })
  const dim = (text: string) => Text({ color: DIM, hover: LIT, children: [text] })

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

  const blocks = layout(shown.command, shown.shell, columns)
  const commandLines = lineCount(blocks)
  const canFoldCommand = commandLines > FOLDED_COMMAND_LINES + FOLD_SLACK
  const body = []
  for (const block of canFoldCommand && !isExpanded ? takeLines(blocks, FOLDED_COMMAND_LINES) : blocks) {
    if (block.kind === 'row') {
      body.push(
        Box({
          flexDirection: 'row',
          children: block.pieces.map(piece =>
            Box({ flexShrink: 0, flexGrow: 0, width: piece.source.length, children: [code(piece, piece.source)] }),
          ),
        }),
      )
    } else {
      for (const source of chunks(block.piece.source)) body.push(code(block.piece, source))
    }
  }
  let hidden = canFoldCommand && !isExpanded ? commandLines - FOLDED_COMMAND_LINES : 0
  if (hidden > 0) body.push(dim('…'))

  const result = []
  const lines = outputLines(call.output)
  const canFoldOutput = lines.length > FOLDED_OUTPUT_LINES + FOLD_SLACK
  const visibleLines = canFoldOutput && !isExpanded ? lines.slice(0, FOLDED_OUTPUT_LINES) : lines
  hidden += lines.length - visibleLines.length
  if (call.isRunning) result.push(dim('Running…'))
  else if (lines.length === 0) result.push(dim('(no output)'))
  else for (const text of chunks(visibleLines.join('\n'))) result.push(dim(text))

  if (expandedIds === undefined) {
    if (hidden > 0) result.push(dim(`… +${hidden} lines`))
  } else if (hidden > 0 || (isExpanded && (canFoldCommand || canFoldOutput))) {
    result.push(
      Box({
        children: [
          Button({
            key: `toggle-${call.id}`,
            label: hidden > 0 ? `… +${hidden} lines` : 'show less',
            variant: 'secondary',
            onPress: () => toggle($, call.id),
          }),
        ],
      }),
    )
  }
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadExpanded($)
    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await loadExpanded($)
    return next(e)
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const calls = e.props.calls.map((call, index) => ({
      call: { ...call, id: call.tool_use_id ?? `${String(e.requestId)}-${index}` },
      shown: shellCommand(call.tool, call.input),
    }))
    const shellCalls = calls.filter(one => one.shown !== undefined)
    if (shellCalls.length === 0) return next(e)
    if (e.props.isExpanded) return next(e)
    if (shellCalls.length === calls.length) return next({ ...e, props: { ...e.props, isExpanded: true } })

    const { Box } = $.ui.resolve(e)
    const rows = [await next(e)]
    for (const one of shellCalls) {
      if (one.shown !== undefined) rows.push(draw($, e, one.call, one.shown, undefined, e.viewport?.columns))
    }
    return Box({ flexDirection: 'column', children: rows })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const shown = shellCommand(e.props.tool, e.props.input)
    if (shown === undefined) return next(e)
    const call = { ...e.props, id: e.props.tool_use_id }
    drawnRows.add(call.id)
    return draw($, e, call, shown, await read($, expanded), e.viewport?.columns)
  })

  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (!drawnRows.has(e.props.tool_use_id)) return next(e)
    const { Box } = $.ui.resolve(e)
    return Box({ children: [] })
  })
}
