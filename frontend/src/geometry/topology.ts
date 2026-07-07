import type { TreeState } from '../types/tree'
import type { PackingState } from '../types/solve'

/** True when the tree's node-id set no longer matches the packing's (a node
 * was added or removed since the last solve) — edge-length-only edits don't
 * count, since the packing's positions dict is keyed purely by node id. */
export function isPackingStale(tree: TreeState, packing: PackingState | null): boolean {
  if (!packing) return false
  const treeIds = Object.keys(tree.nodes)
  if (treeIds.length !== Object.keys(packing.positions).length) return true
  return treeIds.some((id) => packing.positions[id] == null)
}
