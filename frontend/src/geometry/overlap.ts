import { intersect, FillRule } from 'clipper2-ts'
import { buildShapePoints, getBases, type ShapeKind } from './shapes'
import { buildTreeGraph, findDistance } from './treeDistance'
import { computeRiverBands, type RiverBand } from './rivers'
import type { TreeState } from '../types/tree'
import type { SymmetryMode } from '../types/constraints'
import { getLeaves } from './treeGeometry'

export interface OverlapPair {
  a: string
  b: string
}

/** Hard-max separating-axis check (the real-time UI analogue of the solver's
 * smooth-max constraint): flags a pair as overlapping/too-close whenever the
 * shapes' separation along every one of the shape's face-normal directions
 * (or plain Euclidean distance, for a circle) is less than scale * tree
 * distance between the two leaves. `symmetryMode`/`extraRotation` only
 * affect hexagon (see `geometry/shapes.ts`). */
export function findAllOverlaps(
  tree: TreeState,
  positions: Record<string, { x: number; y: number }>,
  scale: number,
  shape: ShapeKind,
  symmetryMode: SymmetryMode = 'none',
  extraRotation = false,
): OverlapPair[] {
  const leaves = getLeaves(tree).filter((id) => positions[id])
  if (leaves.length < 2) return []

  const graph = buildTreeGraph(tree)
  const bases = getBases(shape, symmetryMode, extraRotation)
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

function toClipperPaths(rings: { x: number; y: number }[][]): { x: number; y: number }[][] {
  return rings.map((ring) => ring.map((p) => ({ x: p.x * CLIPPER_SCALE, y: p.y * CLIPPER_SCALE })))
}

function fromClipperPaths(paths: { x: number; y: number }[][]): { x: number; y: number }[][] {
  return paths.map((ring) => ring.map((p) => ({ x: p.x / CLIPPER_SCALE, y: p.y / CLIPPER_SCALE })))
}

export interface OverlapArea {
  a: string
  b: string
  rings: { x: number; y: number }[][]
}

/** The actual overlap polygon for every overlapping pair — flap-flap (via
 * `findAllOverlaps`'s cheap separating-axis pre-filter), plus river-river
 * and flap-river (rivers are arbitrary, possibly concave/multi-ring shapes,
 * so there's no cheap SAT pre-filter for those — river/internal-node counts
 * are small enough that a direct pairwise `intersect` is cheap). A tiny
 * overlap renders as a tiny red area instead of a same-size warning line
 * regardless of how much the shapes actually intersect. */
export function computeOverlapAreas(
  tree: TreeState,
  positions: Record<string, { x: number; y: number }>,
  scale: number,
  shape: ShapeKind,
  symmetryMode: SymmetryMode = 'none',
  extraRotation = false,
): OverlapArea[] {
  const areas: OverlapArea[] = []

  const pairs = findAllOverlaps(tree, positions, scale, shape, symmetryMode, extraRotation)
  for (const { a, b } of pairs) {
    const pa = positions[a]
    const pb = positions[b]
    const la = tree.nodes[a]?.length
    const lb = tree.nodes[b]?.length
    if (pa == null || pb == null || la == null || lb == null) continue
    const polyA = toClipperRing(buildShapePoints(shape, pa.x, pa.y, scale * la, symmetryMode, extraRotation))
    const polyB = toClipperRing(buildShapePoints(shape, pb.x, pb.y, scale * lb, symmetryMode, extraRotation))
    const result = intersect([polyA], [polyB], FillRule.NonZero)
    if (result.length === 0) continue
    areas.push({ a, b, rings: fromClipperPaths(result) })
  }

  const rivers: RiverBand[] = computeRiverBands(tree, positions, scale, shape, symmetryMode, extraRotation)
  for (let i = 0; i < rivers.length; i++) {
    for (let j = i + 1; j < rivers.length; j++) {
      const result = intersect(toClipperPaths(rivers[i].rings), toClipperPaths(rivers[j].rings), FillRule.NonZero)
      if (result.length === 0) continue
      areas.push({ a: rivers[i].nodeId, b: rivers[j].nodeId, rings: fromClipperPaths(result) })
    }
  }

  const leaves = getLeaves(tree).filter((id) => positions[id])
  for (const leafId of leaves) {
    const p = positions[leafId]
    const len = tree.nodes[leafId]?.length
    if (p == null || len == null) continue
    const flapPoly = toClipperRing(buildShapePoints(shape, p.x, p.y, scale * len, symmetryMode, extraRotation))
    for (const river of rivers) {
      const result = intersect([flapPoly], toClipperPaths(river.rings), FillRule.NonZero)
      if (result.length === 0) continue
      areas.push({ a: leafId, b: river.nodeId, rings: fromClipperPaths(result) })
    }
  }

  return areas
}
