import type { ConstraintsState } from './constraints'
import type { HyperparamsState } from './hyperparams'
import type { PackingState } from './solve'
import type { TreeState } from './tree'

export interface SavedSession {
  version: 1
  tree: TreeState
  constraints: ConstraintsState
  hyperparams: HyperparamsState
  packing: PackingState | null
}

export function isSavedSession(data: unknown): data is SavedSession {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return d.version === 1 && typeof d.tree === 'object' && typeof d.constraints === 'object' && typeof d.hyperparams === 'object'
}
