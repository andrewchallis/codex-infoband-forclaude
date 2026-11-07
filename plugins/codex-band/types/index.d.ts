export type CodexJob = {
  id: string
  kind: string
  title: string
  status: string
  phase: string | null
  startedAt: string | null
  updatedAt: string | null
  workspace: string
}

export type CodexSnapshot = { found: boolean; jobs: CodexJob[]; checkedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'codex-band': { snapshot: Shaped<CodexSnapshot>; isHidden: boolean }
  }
}
