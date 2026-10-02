export type ExpandedCalls = string[]

declare module 'claude-code' {
  interface PluginState {
    'shell-highlight': { expanded: ExpandedCalls }
  }
}
