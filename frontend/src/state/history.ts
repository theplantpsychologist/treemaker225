import type { TreeState } from '../types/tree'
import type { ConstraintsState } from '../types/constraints'
import type { HyperparamsState } from '../types/hyperparams'
import type { PackingState } from '../types/solve'

export interface HistorySnapshot {
  tree: TreeState
  constraints: ConstraintsState
  hyperparams: HyperparamsState
  packing: PackingState | null
  lastSolvedScale: number | null
}

/** Captures the document-ish slices of state worth undoing. Every action that
 * mutates these fields already replaces them immutably (spread-copies, never
 * in-place mutation), so a shallow reference capture is safe — no deep clone
 * needed. */
export function snapshot(state: HistorySnapshot): HistorySnapshot {
  return {
    tree: state.tree,
    constraints: state.constraints,
    hyperparams: state.hyperparams,
    packing: state.packing,
    lastSolvedScale: state.lastSolvedScale,
  }
}

export const HISTORY_LIMIT = 50
