import type { TreeState } from '../types/tree'

export interface Point {
  x: number
  y: number
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
/** Unit-square-space (not pixel-space, so not a sizeTokens.ts entry — a
 * fixed fraction of the paper regardless of zoom). */
const NEIGHBOR_OFFSET = 0.06

function clamp01(p: Point): Point {
  return { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) }
}

/** Where a newly-created node should land, given only packing-space data:
 * the parent's position plus a phyllotaxis-spaced offset (stable per child
 * since sibling index never changes, so it needs no knowledge of the
 * eventual sibling count). Falls back to the center if the parent has no
 * position yet — should be unreachable once callers maintain the
 * packing-position invariant, but keeps this total. */
export function placeNodeNearParent(tree: TreeState, positions: Record<string, Point>, nodeId: string): Point {
  const node = tree.nodes[nodeId]
  const parentId = node?.parentId ?? null
  const parentPos = (parentId && positions[parentId]) || { x: 0.5, y: 0.5 }
  const siblingIndex = parentId ? tree.nodes[parentId].children.indexOf(nodeId) : 0
  const angle = siblingIndex * GOLDEN_ANGLE
  return clamp01({
    x: parentPos.x + NEIGHBOR_OFFSET * Math.cos(angle),
    y: parentPos.y + NEIGHBOR_OFFSET * Math.sin(angle),
  })
}

/** Fills in a position for every node in `tree` that lacks one in
 * `positions`, walking root-first so a parent is always resolved before any
 * child that needs `placeNodeNearParent` off of it. */
export function backfillMissingPositions(tree: TreeState, positions: Record<string, Point>): Record<string, Point> {
  if (!tree.rootId) return positions
  const next = { ...positions }
  const stack = [tree.rootId]
  while (stack.length > 0) {
    const id = stack.pop()!
    const node = tree.nodes[id]
    if (!node) continue
    if (next[id] == null) next[id] = placeNodeNearParent(tree, next, id)
    stack.push(...node.children)
  }
  return next
}

function totalEdgeLength(tree: TreeState): number {
  let total = 0
  for (const node of Object.values(tree.nodes)) {
    if (node.length != null) total += node.length
  }
  return total
}

function neighborsOf(tree: TreeState, id: string): string[] {
  const node = tree.nodes[id]
  const result: string[] = []
  if (node.parentId != null) result.push(node.parentId)
  result.push(...node.children)
  return result
}

function isRenderableLeaf(tree: TreeState, id: string): boolean {
  const node = tree.nodes[id]
  return node.parentId != null && node.children.length === 0
}

/** `id`'s neighbors ordered clockwise on screen by the angle of the tree-
 * editor-drawn edge to each — screen y increases downward, so ascending
 * atan2(dy, dx) sweeps clockwise (east -> south -> west -> north). */
function clockwiseNeighbors(tree: TreeState, id: string): string[] {
  const center = tree.nodes[id]
  return neighborsOf(tree, id)
    .map((n) => {
      const other = tree.nodes[n]
      return { id: n, angle: Math.atan2(other.y - center.y, other.x - center.x) }
    })
    .sort((a, b) => a.angle - b.angle)
    .map((n) => n.id)
}

/** Walks the tree's outer boundary exactly as drawn in the tree editor:
 * start at a leaf, walk to its neighbor, and at every node take the
 * sharpest possible LEFT turn relative to the edge just arrived on —
 * repeating until back at the start. This is the standard technique for
 * tracing a plane tree's silhouette: every one of its (n-1) edges gets
 * crossed exactly twice (once each direction, since a tree has no other
 * face to bound), and each leaf — having only one neighbor — is entered
 * and immediately exited back the same way, so it's visited exactly once.
 * Recording every node the walk lands on that's a leaf reproduces exactly
 * the order the user gets walking around the tree's outside. */
function boundaryLeafOrder(tree: TreeState): string[] {
  const ids = Object.keys(tree.nodes)
  const numEdges = ids.length - 1
  if (numEdges <= 0) return []
  const startLeaf = ids.find((id) => isRenderableLeaf(tree, id))
  if (!startLeaf) return []

  const order: string[] = [startLeaf]
  let prev = startLeaf
  let current = neighborsOf(tree, startLeaf)[0]
  const totalSteps = 2 * numEdges
  for (let step = 1; step < totalSteps; step++) {
    if (isRenderableLeaf(tree, current)) order.push(current)
    const neighbors = clockwiseNeighbors(tree, current)
    const idx = neighbors.indexOf(prev)
    // The neighbor immediately after `prev` in clockwise order -- verified
    // against a compass-point star (N/E/S/W leaves around one branch node)
    // to trace the boundary N->E->S->W, i.e. clockwise overall, matching
    // the requested "next leaf is clockwise on the square" ordering.
    const next = neighbors[(idx + 1) % neighbors.length]
    prev = current
    current = next
  }
  return order
}

/** Maps t in [0,1) onto the unit square's boundary, clockwise ON SCREEN
 * starting at the bottom-left corner (up the left edge first) — matches
 * `boundaryLeafOrder`'s clockwise tree walk, and accounts for the render-
 * time y-flip (the unit square is y-up internally: top edge y=1; corners
 * (0,0),(1,0),(1,1),(0,1) — see geometry/edgePin.ts) so the two compose
 * into a genuinely clockwise arrangement once actually rendered. */
function pointOnSquarePerimeter(t: number): Point {
  const u = ((t % 1) + 1) % 1
  const seg = Math.floor(u * 4)
  const f = u * 4 - seg
  switch (seg) {
    case 0:
      return { x: 0, y: f } // left: (0,0) -> (0,1)
    case 1:
      return { x: f, y: 1 } // top: (0,1) -> (1,1)
    case 2:
      return { x: 1, y: 1 - f } // right: (1,1) -> (1,0)
    default:
      return { x: 1 - f, y: 0 } // bottom: (1,0) -> (0,0)
  }
}

/** The full "cut the square open into a loop" bootstrap: leaves are placed
 * around the paper's perimeter in tree-adjacency-preserving order (per
 * `boundaryLeafOrder`), with arc-length proportional to each leaf's own edge
 * length (like circles tangent on a line, normalized to fractions — scale
 * cancels out). Internal nodes get the average of their children's
 * positions. Invoked explicitly by the store's `initializePacking` action
 * (the toolbar's Initialize/Re-initialize button) — small tree edits after
 * that use the cheaper `placeNodeNearParent` patch instead of recomputing
 * this from scratch. */
export function computeNaiveInitialization(tree: TreeState): { scale: number; positions: Record<string, Point> } {
  const positions: Record<string, Point> = {}
  const total = totalEdgeLength(tree)
  const scale = total > 0 ? 2 / total : 1

  const leaves = boundaryLeafOrder(tree)
  const totalLeafLength = leaves.reduce((sum, id) => sum + (tree.nodes[id].length ?? 0), 0)
  if (totalLeafLength > 0) {
    let cumulative = 0
    for (const id of leaves) {
      const len = tree.nodes[id].length ?? 0
      positions[id] = pointOnSquarePerimeter((cumulative + len / 2) / totalLeafLength)
      cumulative += len
    }
  } else {
    // Degenerate (all-zero-length) tree: spread leaves evenly instead of
    // collapsing every t to the same point.
    leaves.forEach((id, i) => {
      positions[id] = pointOnSquarePerimeter((i + 0.5) / Math.max(leaves.length, 1))
    })
  }

  // Internal nodes: post-order average of children — every child is already
  // resolved (leaf or internal) by the time its parent is computed.
  const visitInternal = (id: string): Point | null => {
    const node = tree.nodes[id]
    if (!node) return null
    if (node.children.length === 0) return positions[id] ?? null
    let sx = 0
    let sy = 0
    let count = 0
    for (const childId of node.children) {
      const p = visitInternal(childId)
      if (p) {
        sx += p.x
        sy += p.y
        count++
      }
    }
    const pos = count > 0 ? { x: sx / count, y: sy / count } : { x: 0.5, y: 0.5 }
    positions[id] = pos
    return pos
  }
  if (tree.rootId) visitInternal(tree.rootId)

  return { scale, positions }
}

/** Cheap scale refresh for a still-naive packing (never touches a real
 * solved scale — gate on `PackingDiagnostics.kind === 'naive'` at the call
 * site). Recomputed on every edit since it's O(edges), not memoized. */
export function naiveScale(tree: TreeState): number {
  const total = totalEdgeLength(tree)
  return total > 0 ? 2 / total : 1
}
