export interface NodePositionOut {
  nodeId: string
  x: number
  y: number
}

export type InitFrom = 'random' | 'current'

export interface SolveDiagnostics {
  restartsAttempted: number
  bestScaleCircle: number
  bestScaleOctagon: number | null
  solveTimeMs: number
}

export interface SolveResponse {
  status: 'ok' | 'error'
  message?: string | null
  scale: number
  leafPositions: NodePositionOut[]
  internalPositions: NodePositionOut[]
  diagnostics: SolveDiagnostics
}

export interface PackingState {
  scale: number
  /** Positions for both leaf and internal node ids. */
  positions: Record<string, { x: number; y: number }>
  diagnostics: SolveDiagnostics
}
