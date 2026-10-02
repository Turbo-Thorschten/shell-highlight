# shell-highlight

A [Claude Code](https://code.claude.com) mod that draws `Bash` and `PowerShell` tool calls with syntax-highlighted commands.

Claude Code prints shell commands in a single colour. Long one-liners, heredocs and pipelines are hard to scan that way. This mod redraws those rows in the transcript so the command is coloured by Claude Code's own highlighter, the same one that colours fenced code blocks.

```
● Bash  List the five largest files
  du -ah . | sort -rh | head -n 5          <- highlighted as bash
  1.2G    ./node_modules
  340M    ./dist
  …
  [ … +2 lines ]                           <- click to unfold
```

## What it does

- **Highlights the command** of every `Bash` and `PowerShell` call (`bash` and `powershell` grammars).
- **Shows the call's description** dimmed next to the tool name.
- **Status dot:** dim while the call runs, green when it succeeded, red when it failed or was interrupted.
- **Folds long output:** the first 5 lines are shown; a button unfolds up to 200 lines and folds them again.
- **Leaves everything else alone:** other tools keep Claude Code's own rows.

## Requirements

- Claude Code **2.1.287 or newer** (the first version with mods, also called function hooks).
- The mods API is early access and may change between releases.

## Install

Clone the repository and point Claude Code at the folder:

```sh
git clone https://github.com/Turbo-Thorschten/shell-highlight.git
claude --plugin-dir ./shell-highlight
```

To load it in every session, set `CLAUDE_CODE_PLUGIN_DIRS` to the absolute path of the folder, either in your environment or in the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/shell-highlight"
  }
}
```

`/plugin` lists the mod once it is loaded.

## How it works

The whole mod is one hooks module, [`hooks/register.ts`](hooks/register.ts), with two `ui.render` hooks:

1. **`ToolGroup`**: Claude Code folds runs of shell calls into a group. The hook unfolds every group that holds a shell call, so each call is drawn as its own row.
2. **`ToolUse`**: for a `Bash` or `PowerShell` row, the hook returns its own tree: a header, a `Code` element with the command, and the first lines of the output.

It only changes how rows are drawn. The command that runs, its permissions and its result are untouched. The mod makes no file, process or network calls; `claude plugin validate` reports exactly `$.ui.resolve`, `$.state.get` and `$.state.set`.

## Limitations

- **Whole groups unfold.** If a `Read` or `Grep` call shares a group with a shell call, it is drawn as its own row too.
- **Hover and click belong to the group.** Claude Code lights up and selects a whole group at once; a mod cannot change that.
- **Inline code in other languages is not highlighted.** `node -e '…'` is coloured as one bash string.
- **Some commands fall back to the plain row:** longer than 10,000 characters, or containing control characters such as ESC.
- **Unfolded state is per session** and is reset by `/clear`, `/resume` and `/branch`.
- Tested on the terminal surface only.

## Development

```sh
claude plugin validate .   # what the module hooks and calls, and anything the engine would refuse
claude plugin test .       # runs tests/*.test.ts
npx -p typescript tsc -p . # type-check; needs .claude-plugin/types/, which Claude Code writes when it loads the mod
```

## License

[MIT](LICENSE)
