import type { TreeIn } from '../types/tree'
import type { ConstraintsState } from '../types/constraints'
import type { HyperparamsState } from '../types/hyperparams'
import type { InitFrom, NodePositionOut, SolveResponse } from '../types/solve'
import type { SnapPathsResponse } from '../types/snap'

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

export async function fetchSnapPaths(
  tree: TreeIn,
  constraints: ConstraintsState,
  hyperparams: HyperparamsState,
  positions: NodePositionOut[],
  scale: number,
): Promise<SnapPathsResponse> {
  const res = await fetch(`${API_BASE}/api/snap-paths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tree, constraints, hyperparams, positions, scale }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.detail ?? `Snap failed (${res.status})`)
  }
  return res.json() as Promise<SnapPathsResponse>
}
