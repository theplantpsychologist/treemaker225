import { OCT_BASES } from './octagon'
import { buildTreeGraph, findDistance } from './treeDistance'
import type { TreeState } from '../types/tree'
import { getLeaves } from './treeGeometry'

export interface OverlapPair {
  a: string
  b: string
}

/** Hard-max separating-axis check (the real-time UI analogue of the solver's
 * smooth-max constraint): flags a pair as overlapping/too-close whenever the
 * octagons' separation along every one of the 8 face-normal directions is
 * less than scale * tree distance between the two leaves. */
export function findAllOverlaps(
  tree: TreeState,
  positions: Record<string, { x: number; y: number }>,
  scale: number,
): OverlapPair[] {
  const leaves = getLeaves(tree).filter((id) => positions[id])
  if (leaves.length < 2) return []

  const graph = buildTreeGraph(tree)
  const overlaps: OverlapPair[] = []

  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i]
      const b = leaves[j]
      const pa = positions[a]
      const pb = positions[b]
      const dx = pa.x - pb.x
      const dy = pa.y - pb.y
      const separation = Math.max(...OCT_BASES.map(([bx, by]) => dx * bx + dy * by))
      const required = scale * findDistance(graph, a, b)
      if (separation < required) overlaps.push({ a, b })
    }
  }

  return overlaps
}
