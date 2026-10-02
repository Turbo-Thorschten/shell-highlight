import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const LANGUAGES: Record<string, string> = { Bash: 'bash', PowerShell: 'powershell' }
const MAX_SOURCE = 10000
const FOLDED_LINES = 5
const UNFOLDED_LINES = 200
const REFUSED_BY_CODE = /[\u0000-\u0008\u000b-\u001f\u007f]/
const REFUSED_BY_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]/g

const expanded = atom({ plugin: 'shell-highlight', key: 'expanded' } as const, [])
const unfolded = new Set<string>()

function outputLines(output: unknown): string[] {
  const parts =
    typeof output === 'string'
      ? [output]
      : output !== null && typeof output === 'object'
        ? [(output as { stdout?: unknown }).stdout, (output as { stderr?: unknown }).stderr]
        : []
  const text = parts
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join('\n')
    .replace(/\r\n?/g, '\n')
    .replace(REFUSED_BY_TEXT, '')
    .trim()
  return text === '' ? [] : text.split('\n')
}

export const register: Register = on => {
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    const shellCalls = e.props.calls.filter(call => LANGUAGES[call.tool] !== undefined)
    if (shellCalls.length === 0) return next(e)
    for (const call of shellCalls) if (call.tool_use_id !== undefined) unfolded.add(call.tool_use_id)
    return next({ ...e, props: { ...e.props, isExpanded: true } })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const language = LANGUAGES[e.props.tool]
    const input = e.props.input as { command?: unknown; description?: unknown } | null
    if (language === undefined || typeof input?.command !== 'string') return next(e)

    const command = input.command.replace(/\r\n?/g, '\n')
    if (command === '' || command.length > MAX_SOURCE || REFUSED_BY_CODE.test(command)) return next(e)

    const { Box, Text, Code, Button } = $.ui.resolve(e)
    const id = e.props.tool_use_id
    const dot = e.props.isRunning
      ? Text({ dimColor: true, children: ['●'] })
      : Text({ color: e.props.isErrored || e.props.isInterrupted ? 'red' : 'green', children: ['●'] })
    const header = [
      Box({ flexDirection: 'row', gap: 1, flexShrink: 0, children: [dot, Text({ bold: true, children: [e.props.tool] })] }),
    ]
    if (typeof input.description === 'string' && input.description !== '') {
      header.push(Text({ dimColor: true, children: [input.description] }))
    }
    if (e.props.isInterrupted) header.push(Text({ dimColor: true, children: ['Interrupted'] }))

    const rows = [
      Box({ flexDirection: 'row', gap: 1, children: header }),
      Box({ paddingLeft: 2, children: [Code({ source: command, language })] }),
    ]
    if (unfolded.has(id)) {
      const lines = outputLines(e.props.output)
      const isExpanded = (await read($, expanded)).includes(id)
      const shown = lines.slice(0, isExpanded ? UNFOLDED_LINES : FOLDED_LINES)
      for (const line of shown) {
        rows.push(Box({ paddingLeft: 2, children: [Text({ dimColor: true, wrap: 'truncate-end', children: [line] })] }))
      }
      if (lines.length > shown.length && isExpanded) {
        rows.push(Box({ paddingLeft: 2, children: [Text({ dimColor: true, children: [`… +${lines.length - shown.length} lines`] })] }))
      }
      if (lines.length > FOLDED_LINES) {
        rows.push(
          Box({
            paddingLeft: 2,
            children: [
              Button({
                key: 'toggle',
                label: isExpanded ? 'show less' : `… +${lines.length - FOLDED_LINES} lines`,
                dimColor: true,
                onPress: () =>
                  update($, expanded, ids => (ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id])),
              }),
            ],
          }),
        )
      }
    }

    return Box({ flexDirection: 'column', marginTop: 1, children: rows })
  })
}
