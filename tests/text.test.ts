import { describe, expect, test } from 'claude-code/testing'

import { cells, chunks, findLinks, sniffLanguage, layout, lineCount, linkify, linkRows, linkTarget, outputLines, takeLines, visible } from '../hooks/text'
import type { Block } from '../hooks/text'

const shape = (blocks: Block[]) =>
  blocks.map(block =>
    block.kind === 'code'
      ? `${block.piece.language ?? block.piece.path ?? 'plain'}:${block.piece.source}`
      : block.pieces.map(piece => `${piece.language ?? piece.path ?? 'plain'}:${piece.source}`),
  )

describe('layout', () => {
  test('a plain command is one block in the shell language', async () => {
    expect(shape(layout('ls -la | head -n 3', 'bash', 80))).toEqual(['bash:ls -la | head -n 3'])
  })

  test('a heredoc body takes the language of its interpreter', async () => {
    const command = "node <<'EOF'\nconst a = 1\nconsole.log(a)\nEOF"
    expect(shape(layout(command, 'bash', 80))).toEqual([
      "bash:node <<'EOF'",
      'javascript:const a = 1\nconsole.log(a)',
      'bash:EOF',
    ])
  })

  test('a heredoc redirected to a file is highlighted by the file name', async () => {
    const command = "cat > /tmp/demo.py <<'EOF'\nimport sys\nEOF"
    expect(shape(layout(command, 'bash', 80))).toEqual(["bash:cat > /tmp/demo.py <<'EOF'", '/tmp/demo.py:import sys', 'bash:EOF'])
  })

  test('a heredoc without a known language is drawn plain', async () => {
    const command = "git commit -F - <<'EOF'\nFix the thing\nEOF"
    expect(shape(layout(command, 'bash', 80))).toEqual(["bash:git commit -F - <<'EOF'", 'plain:Fix the thing', 'bash:EOF'])
  })

  test('an inline script that fits is split into pieces on one row', async () => {
    expect(shape(layout(`node -e 'console.log(1)' && echo ok`, 'bash', 80))).toEqual([
      ["bash:node -e '", 'javascript:console.log(1)', "bash:'", 'bash: && echo ok'],
    ])
  })

  test('an inline script wider than the room is wrapped at spaces', async () => {
    const command = `node -e 'console.log(1)' && echo ok`
    expect(shape(layout(command, 'bash', 20))).toEqual([
      ["bash:node -e '"],
      ['javascript:console.log(1)', "bash:'", 'bash: && '],
      ['bash:echo ok'],
    ])
  })

  test('a wrap prefers a space outside a string', async () => {
    const command = `node -e 'log("a b c d e f g"); done()'`
    expect(shape(layout(command, 'bash', 31))).toEqual([
      ["bash:node -e '", 'javascript:log("a b c d e f g"); '],
      ['javascript:done()', "bash:'"],
    ])
  })

  test('a word longer than the room is cut', async () => {
    const command = `node -e '${'x'.repeat(50)}'`
    expect(shape(layout(command, 'bash', 20))).toEqual([
      ["bash:node -e '"],
      [`javascript:${'x'.repeat(20)}`],
      [`javascript:${'x'.repeat(20)}`],
      [`javascript:${'x'.repeat(10)}`, "bash:'"],
    ])
  })

  test('wide characters count as two cells', async () => {
    expect(cells('日本 ok')).toBe(7)
    expect(shape(layout(`python -c 'print("日本")'`, 'bash', 80))).toEqual([
      ["bash:python -c '", 'python:print("日本")', "bash:'"],
    ])
  })

  test('a row with characters of unsure width stays one shell block', async () => {
    const command = `python -c 'print("é")'`
    expect(shape(layout(command, 'bash', 80))).toEqual([`bash:${command}`])
  })

  test('cmd /c and an interactive shell take their script as code', async () => {
    expect(shape(layout(`cmd /c "dir /b"`, 'powershell', 80))).toEqual([['powershell:cmd /c "', 'bat:dir /b', 'powershell:"']])
    expect(shape(layout(`wsl -e zsh -ic 'uv --version'`, 'powershell', 80))).toEqual([
      ["powershell:wsl -e zsh -ic '", 'bash:uv --version', "powershell:'"],
    ])
  })

  test('a multi-line inline script keeps its lines', async () => {
    const command = `node -e '\nconst a = 1\nconsole.log(a)\n' && echo done`
    expect(shape(layout(command, 'bash', 80))).toEqual([
      "bash:node -e '",
      'javascript:const a = 1\nconsole.log(a)',
      ["bash:'", 'bash: && echo done'],
    ])
  })

  test("bash's quote-escape idiom does not end the script", async () => {
    const command = `python3 -c 'print('\\''hi'\\'')'`
    expect(shape(layout(command, 'bash', 80))).toEqual([["bash:python3 -c '", "python:print('\\''hi'\\'')", "bash:'"]])
  })

  test('a flag the interpreter does not evaluate is left alone', async () => {
    expect(shape(layout(`node script.js 'arg'`, 'bash', 80))).toEqual([`bash:node script.js 'arg'`])
  })

  test('a PowerShell here-string takes the language of its interpreter', async () => {
    const command = `python -c @'\nimport os\nprint(os.name)\n'@`
    expect(shape(layout(command, 'powershell', 80))).toEqual([
      "powershell:python -c @'",
      'python:import os\nprint(os.name)',
      "powershell:'@",
    ])
  })

  test('a PowerShell here-string piped to a file is highlighted by the file name', async () => {
    const command = `@'\n{ "a": 1 }\n'@ | Set-Content -Path out.json`
    expect(shape(layout(command, 'powershell', 80))).toEqual([
      "powershell:@'",
      'out.json:{ "a": 1 }',
      ["powershell:'@", 'powershell: | Set-Content -Path out.json'],
    ])
  })
})

describe('folding', () => {
  const blocks = layout("node <<'EOF'\na\nb\nc\nEOF", 'bash', 80)

  test('lines are counted across blocks', async () => {
    expect(lineCount(blocks)).toBe(5)
  })

  test('taking lines cuts inside a block', async () => {
    expect(shape(takeLines(blocks, 3))).toEqual(["bash:node <<'EOF'", 'javascript:a\nb'])
  })
})

describe('text', () => {
  test('control characters in a command are made visible', async () => {
    expect(visible('printf "\u001b[31mred"\r\nexit')).toBe('printf "␛[31mred"\nexit')
  })

  test('output joins stdout and stderr, without colour codes or trailing blank lines', async () => {
    expect(outputLines({ stdout: '\u001b[31mred\u001b[0m\r\nplain\n\n', stderr: 'warning' })).toEqual(['red', 'plain', 'warning'])
  })

  test('an errored call carries its text as a string', async () => {
    expect(outputLines('Exit code 2\nno such file')).toEqual(['Exit code 2', 'no such file'])
  })

  test('no output is no lines', async () => {
    expect(outputLines({ stdout: '', stderr: '' })).toEqual([])
    expect(outputLines(undefined)).toEqual([])
  })

  test('long text is split at line breaks into elements of at most 10000 characters', async () => {
    const line = 'x'.repeat(4000)
    const parts = chunks([line, line, line].join('\n'))
    expect(parts.map(part => part.length)).toEqual([8001, 4000])
  })

  test('a single line longer than an element is cut', async () => {
    expect(chunks('y'.repeat(25000)).map(part => part.length)).toEqual([10000, 10000, 5000])
  })

  test('an empty text is still an element', async () => {
    expect(chunks('')).toEqual([' '])
  })
})

describe('linkTarget', () => {
  test('a Windows path becomes a file URL with escaped spaces and parentheses', async () => {
    expect(linkTarget('C:\\Program Files (x86)\\a#b.txt')).toBe('file:///C:/Program%20Files%20%28x86%29/a%23b.txt')
  })

  test('a UNC path keeps its host', async () => {
    expect(linkTarget('\\\\server\\share\\a.txt')).toBe('file://server/share/a.txt')
  })

  test('a POSIX path and a URL', async () => {
    expect(linkTarget('/home/me/a b.md')).toBe('file:///home/me/a%20b.md')
    expect(linkTarget('https://example.com/wiki/A_(b)')).toBe('https://example.com/wiki/A_%28b%29')
  })
})

describe('findLinks', () => {
  const targets = (text: string) => findLinks(text, { home: 'C:\\Users\\me' }).map(one => one.target)

  test('paths and URLs are found, trailing punctuation is not part of them', async () => {
    expect(targets('node "C:\\a\\run.mjs" 2>&1; see https://x.org/a. or /etc/hosts, ~/.claude/x.md')).toEqual([
      'C:\\a\\run.mjs',
      'https://x.org/a',
      '/etc/hosts',
      'C:\\Users\\me/.claude/x.md',
    ])
  })

  test('flags, fractions, drive-less words and URL paths are not paths', async () => {
    expect(targets('cmd /c dir 1/2/3 and/or $env:HOME -NotMatch a|b')).toEqual([])
    expect(targets('https://example.com/a/b')).toEqual(['https://example.com/a/b'])
  })

  test('without a home directory a ~ path is left alone', async () => {
    expect(findLinks('cat ~/.zshrc', {})).toEqual([])
  })
})

describe('sniffLanguage', () => {
  test('a text file is sniffed by its content, a known extension is left to the highlighter', async () => {
    expect(sniffLanguage('C:\\t\\b1.output', '{"a": 1}')).toBe('json')
    expect(sniffLanguage('/t/page.log', '<html></html>')).toBe('xml')
    expect(sniffLanguage('/t/session.txt', 'hello\n$ ls -la\nx')).toBe('shell')
    expect(sniffLanguage('/t/LICENSE', 'MIT License')).toBeUndefined()
    expect(sniffLanguage('/t/a.json', '{"a": 1}')).toBeUndefined()
    expect(sniffLanguage('/t/broken.output', '{ not json')).toBeUndefined()
  })
})

describe('linkify', () => {
  test('a path in text and a path filling a code span become links; other code is kept', async () => {
    expect(linkify('Open C:\\a\\b.md or `/etc/hosts`, not `ls /etc/x/y`', {})).toBe(
      'Open [C:\\\\a\\\\b\\.md](file:///C:/a/b.md) or [/etc/hosts](file:///etc/hosts), not `ls /etc/x/y`',
    )
  })

  test('fences, existing links and bare URLs stay as written', async () => {
    const text = '```\ncat /etc/hosts\n```\n[here](/a/b) https://x.org/a'
    expect(linkify(text, {})).toBe(text)
  })
})

describe('links in commands and output', () => {
  test('a command line with a path is split into a linked piece', async () => {
    const blocks = layout('node "C:\\a\\run.mjs" x', 'powershell', 80, {})
    expect(blocks).toEqual([
      {
        kind: 'row',
        pieces: [
          { source: 'node "', language: 'powershell' },
          { source: 'C:\\a\\run.mjs', language: 'powershell', link: 'C:\\a\\run.mjs' },
          { source: '" x', language: 'powershell' },
        ],
      },
    ])
  })

  test('a path wider than the row is wrapped and each part keeps the link', async () => {
    const rows = linkRows('/aaaa/bbbb/cccc', 8, {}) ?? []
    expect(rows.map(row => row.map(piece => [piece.source, piece.link]))).toEqual([
      [['/aaaa/bb', '/aaaa/bbbb/cccc']],
      [['bb/cccc', '/aaaa/bbbb/cccc']],
    ])
  })

  test('an output line without a path is not split', async () => {
    expect(linkRows('total 12', 80, {})).toBeUndefined()
  })
})
