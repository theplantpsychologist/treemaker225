import type { TreeState } from '../types/tree'

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Shortest distance from `p` to the segment `a`-`b` (0 if `a === b`). */
export function distanceToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const lengthSq = abx * abx + aby * aby
  if (lengthSq < 1e-12) return distance(p, a)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq))
  return distance(p, { x: a.x + t * abx, y: a.y + t * aby })
}

/** All descendant ids of nodeId, including nodeId itself (pre-order). */
export function collectSubtreeIds(tree: TreeState, nodeId: string): string[] {
  const result: string[] = []
  const stack = [nodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    result.push(id)
    stack.push(...tree.nodes[id].children)
  }
  return result
}

export function getLeaves(tree: TreeState): string[] {
  return Object.values(tree.nodes)
    .filter((n) => n.children.length === 0)
    .map((n) => n.id)
}
