export type ShownReads = string[]

declare module 'claude-code' {
  interface PluginState {
    'shell-highlight': { shown: ShownReads }
  }
}
