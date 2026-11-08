export type CodexJob = {
  id: string
  kind: string
  summary: string | null
  status: string
  phase: string | null
  createdAt: string | null
  startedAt: string | null
  updatedAt: string | null
  completedAt: string | null
  workspace: string
  workspaceRoot: string | null
  sessionId: string | null
}

export type CodexSnapshot = { found: boolean; jobs: CodexJob[]; checkedAt: number }

// Codex job id -> the status last written to the requests page and that row's version.
export type LoggedRows = Record<string, { status: string; version: number }>

declare module 'claude-code' {
  interface PluginState {
    'codex-band': {
      snapshot: Shaped<CodexSnapshot>
      isHidden: boolean
      isShown: boolean
      isPulseOn: boolean
      logged: Shaped<LoggedRows>
      lastCommand: string
      stopArmed: { id: string; at: number }
    }
  }
}
