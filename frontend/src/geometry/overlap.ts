import { intersect, FillRule } from 'clipper2-ts'
import { buildShapePoints, getBases, type ShapeKind } from './shapes'
import { buildTreeGraph, findDistance } from './treeDistance'
import type { TreeState } from '../types/tree'
import { getLeaves } from './treeGeometry'

export interface OverlapPair {
  a: string
  b: string
}

/** Hard-max separating-axis check (the real-time UI analogue of the solver's
 * smooth-max constraint): flags a pair as overlapping/too-close whenever the
 * shapes' separation along every one of the shape's face-normal directions
 * (or plain Euclidean distance, for a circle) is less than scale * tree
 * distance between the two leaves. */
export function findAllOverlaps(
  tree: TreeState,
  positions: Record<string, { x: number; y: number }>,
  scale: number,
  shape: ShapeKind,
): OverlapPair[] {
  const leaves = getLeaves(tree).filter((id) => positions[id])
  if (leaves.length < 2) return []

  const graph = buildTreeGraph(tree)
  const bases = getBases(shape)
  const overlaps: OverlapPair[] = []

  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i]
      const b = leaves[j]
      const pa = positions[a]
      const pb = positions[b]
      const dx = pa.x - pb.x
      const dy = pa.y - pb.y
      const separation = bases ? Math.max(...bases.map(([bx, by]) => dx * bx + dy * by)) : Math.hypot(dx, dy)
      const required = scale * findDistance(graph, a, b)
      if (separation < required) overlaps.push({ a, b })
    }
  }

  return overlaps
}

/** Same numeric-range rationale as `geometry/rivers.ts`'s CLIPPER_SCALE. */
const CLIPPER_SCALE = 100000

function toClipperRing(points: [number, number][]): { x: number; y: number }[] {
  return points.map(([x, y]) => ({ x: x * CLIPPER_SCALE, y: y * CLIPPER_SCALE }))
}

export interface OverlapArea {
  a: string
  b: string
  rings: { x: number; y: number }[][]
}

/** The actual overlap polygon for every flagged pair (via `findAllOverlaps`'s
 * cheap separating-axis check), so a tiny overlap renders as a tiny red
 * area instead of a same-size warning line regardless of how much the
 * shapes actually intersect. */
export function computeOverlapAreas(
  tree: TreeState,
  positions: Record<string, { x: number; y: number }>,
  scale: number,
  shape: ShapeKind,
): OverlapArea[] {
  const pairs = findAllOverlaps(tree, positions, scale, shape)
  const areas: OverlapArea[] = []
  for (const { a, b } of pairs) {
    const pa = positions[a]
    const pb = positions[b]
    const la = tree.nodes[a]?.length
    const lb = tree.nodes[b]?.length
    if (pa == null || pb == null || la == null || lb == null) continue
    const polyA = toClipperRing(buildShapePoints(shape, pa.x, pa.y, scale * la))
    const polyB = toClipperRing(buildShapePoints(shape, pb.x, pb.y, scale * lb))
    const result = intersect([polyA], [polyB], FillRule.NonZero)
    if (result.length === 0) continue
    const rings = result.map((ring) => ring.map((p) => ({ x: p.x / CLIPPER_SCALE, y: p.y / CLIPPER_SCALE })))
    areas.push({ a, b, rings })
  }
  return areas
}
