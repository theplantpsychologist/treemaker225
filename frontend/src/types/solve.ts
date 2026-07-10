export interface NodePositionOut {
  nodeId: string
  x: number
  y: number
}

export type InitFrom = 'random' | 'current'

export interface SolveDiagnostics {
  restartsAttempted: number
  bestScaleCircle: number
  bestScaleRefined: number | null
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

/** Distinguishes a naive/placeholder packing (built client-side before the
 * user has ever run a real solve) from the product of an actual backend
 * solve — gates whether the cheap naive-scale refresh may touch
 * `packing.scale` (see `state/store.ts`'s `addChildAt`/`deleteNodeById`). */
export type PackingDiagnostics = { kind: 'naive' } | ({ kind: 'solved' } & SolveDiagnostics)

export interface PackingState {
  scale: number
  /** Positions for both leaf and internal node ids. */
  positions: Record<string, { x: number; y: number }>
  diagnostics: PackingDiagnostics
}
