import type { TreeState } from '../types/tree'

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
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
