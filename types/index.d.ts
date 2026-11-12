export type ShownReads = string[]

export type ToolView = 'full' | 'line' | 'off'

declare module 'claude-code' {
  interface PluginState {
    'shell-highlight': { shown: ShownReads; view: ToolView }
  }
}
