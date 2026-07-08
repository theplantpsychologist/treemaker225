import type { TreeIn } from '../types/tree'
import type { ConstraintsState } from '../types/constraints'
import type { HyperparamsState } from '../types/hyperparams'
import type { InitFrom, NodePositionOut, SolveResponse } from '../types/solve'

export const API_BASE = 'http://localhost:8000'

export interface SolveOptions {
  initFrom: InitFrom
  currentPositions?: NodePositionOut[]
  currentScale?: number
  /** Only meaningful with initFrom:'current' — see SolveRequest.seedMultiRestart. */
  seedMultiRestart?: boolean
}

export async function fetchSolve(
  tree: TreeIn,
  constraints: ConstraintsState,
  hyperparams: HyperparamsState,
  options: SolveOptions,
): Promise<SolveResponse> {
  const res = await fetch(`${API_BASE}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tree,
      constraints,
      hyperparams,
      initFrom: options.initFrom,
      currentPositions: options.currentPositions,
      currentScale: options.currentScale,
      seedMultiRestart: options.seedMultiRestart,
    }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.detail ?? `Solve failed (${res.status})`)
  }
  return res.json() as Promise<SolveResponse>
}
