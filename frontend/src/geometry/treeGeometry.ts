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

/** Whenever the root ends up with exactly one child that itself branches
 * further (has at least one child of its own), the root is topologically a
 * leaf of the underlying unrooted tree -- but every algorithm keyed off
 * `parentId === null` (flap/river classification, the naive-init boundary
 * walk, the backend solver's `get_leaves`) treats root as a pure bookkeeping
 * hub that never gets a flap or river of its own, which is only correct for
 * an actual branch point. Swapping root with that single child fixes it:
 * re-rooting doesn't change any node's total degree or any edge's length,
 * only which node is bookkept as parentId === null, so the old root
 * correctly becomes an ordinary leaf (gets a flap using the same edge
 * length as before) while the new root is a genuine branch (contributes no
 * flap/river, exactly like before). A tree with 0 or 2+ children at the
 * root, or whose only child is ALSO childless (the fully degenerate
 * two-node "tree" -- there's only one shared edge length between them, no
 * way to give both ends an independent flap), is returned unchanged.
 * Called after every topology-changing store action so the result never
 * depends on which node the user happened to draw first. */
export function canonicalizeRoot(tree: TreeState): TreeState {
  if (!tree.rootId) return tree
  const root = tree.nodes[tree.rootId]
  if (root.children.length !== 1) return tree
  const childId = root.children[0]
  const child = tree.nodes[childId]
  if (child.children.length === 0) return tree

  const nodes = {
    ...tree.nodes,
    [childId]: { ...child, parentId: null, length: null, children: [...child.children, root.id] },
    [root.id]: { ...root, parentId: childId, length: child.length, children: [] },
  }
  return { rootId: childId, nodes }
}
