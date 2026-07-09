import type { TreeState } from '../types/tree'
import type { SymmetryMode } from '../types/constraints'
import { getBases, type ShapeKind } from './shapes'
import { buildTreeGraph, findDistance } from './treeDistance'
import { getLeaves } from './treeGeometry'

export interface ActivePathLine {
  a: string
  b: string
  kind: 'active'
  ax: number
  ay: number
  bx: number
  by: number
}

/** A pair whose actual center distance is tangency-close, but whose
 * connecting line isn't (within tolerance) perpendicular to one of the
 * polygon's sides — the straight path a real crease would follow instead
 * bends through the two flanking perpendicular directions, so this
 * decomposes A->B into that bend and reports its four vertices (in order;
 * an SVG `<polygon>` closes the fourth side automatically). */
export interface ActivePathParallelogram {
  a: string
  b: string
  kind: 'semi-active'
  points: [number, number][]
}

export type ActivePath = ActivePathLine | ActivePathParallelogram

/** Active/semi-active paths between every leaf pair whose actual center
 * distance is at (or within `lengthTolerance` of) the tree-implied tangency
 * distance `scale * findDistance(a, b)` — the same binding-constraint idea
 * as `overlap.ts`'s hard violation check, but testing near-equality on the
 * true center-to-center Euclidean distance (not the SAT-projection bound
 * `findAllOverlaps` uses) since tangency is a property of the two centers
 * themselves, independent of shape. For circle mode every such pair renders
 * as a solid line. For polygon shapes, a pair only renders solid if the
 * line's angle is within `angleToleranceDegrees` of a multiple of the
 * shape's own face-normal spacing (offset by whatever rotation is
 * currently active, via `getBases`) — i.e. approximately perpendicular to a
 * side, matching what a real straight crease path requires. Otherwise it's
 * "semi-active": rendered as a dashed parallelogram decomposing the
 * A->B vector into components along the two flanking allowed directions. */
export function computeActivePaths(
  tree: TreeState,
  positions: Record<string, { x: number; y: number }>,
  scale: number,
  shape: ShapeKind,
  symmetryMode: SymmetryMode,
  extraRotation: boolean,
  lengthTolerance: number,
  angleToleranceDegrees: number,
): ActivePath[] {
  const leaves = getLeaves(tree).filter((id) => positions[id])
  if (leaves.length < 2) return []

  const graph = buildTreeGraph(tree)
  const bases = getBases(shape, symmetryMode, extraRotation)
  const angleTolerance = (angleToleranceDegrees * Math.PI) / 180
  const results: ActivePath[] = []

  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i]
      const b = leaves[j]
      const pa = positions[a]
      const pb = positions[b]
      const dx = pb.x - pa.x
      const dy = pb.y - pa.y
      const dist = Math.hypot(dx, dy)
      const required = scale * findDistance(graph, a, b)
      if (required <= 0) continue
      if (Math.abs(dist / required - 1) > lengthTolerance) continue

      if (!bases) {
        results.push({ a, b, kind: 'active', ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y })
        continue
      }

      const n = bases.length
      const period = (2 * Math.PI) / n
      const offsetAngle = Math.atan2(bases[0][1], bases[0][0])
      const theta = Math.atan2(dy, dx)
      const k = Math.round((theta - offsetAngle) / period)
      const nearest = offsetAngle + k * period
      const rel = theta - nearest

      if (Math.abs(rel) <= angleTolerance) {
        results.push({ a, b, kind: 'active', ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y })
        continue
      }

      const thetaLo = nearest
      const thetaHi = nearest + Math.sign(rel) * period
      const u1x = Math.cos(thetaLo)
      const u1y = Math.sin(thetaLo)
      const u2x = Math.cos(thetaHi)
      const u2y = Math.sin(thetaHi)
      const det = u1x * u2y - u1y * u2x
      if (Math.abs(det) < 1e-9) {
        results.push({ a, b, kind: 'active', ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y })
        continue
      }
      const coeffA = (dx * u2y - dy * u2x) / det
      const coeffB = (dy * u1x - dx * u1y) / det
      const p1: [number, number] = [pa.x + coeffA * u1x, pa.y + coeffA * u1y]
      const p2: [number, number] = [pa.x + coeffB * u2x, pa.y + coeffB * u2y]
      results.push({
        a,
        b,
        kind: 'semi-active',
        points: [[pa.x, pa.y], p1, [pb.x, pb.y], p2],
      })
    }
  }

  return results
}
