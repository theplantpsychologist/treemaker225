import type { EdgeSide, SymmetryMode } from '../types/constraints'
import type { Point } from './symmetry'
import { getBases, type ShapeKind } from './shapes'
import { columnKey, type Row } from './tilingLinAlg'

/** Geometric primitives for the manual tiling editor: shape bin/angle
 * math, the 2-leg parallelogram decomposition, segment crossing, a convex
 * hull, and the two row-builders (`legRow`/`nearestEdgeRow`). Fresh code
 * (not extracted from the dormant backend `tiling_candidates.py`/
 * `tiling_solve.py`) so those files stay untouched, but deliberately
 * mirrors their math -- and, for the bend decomposition specifically,
 * mirrors the already-tested TS parallelogram math in `geometry/
 * activePaths.ts` (same `coeffA`/`coeffB` formulas), just returning both
 * candidate bend points explicitly instead of one dashed-preview shape. */

const PARALLEL_EPS = 1e-9

export interface BinGeometry {
  n: number
  period: number
  offsetAngle: number
}

/** `null` for shapes with no discrete crease directions (circle). */
export function getBinGeometry(shape: ShapeKind, symmetryMode: SymmetryMode, extraRotation: boolean): BinGeometry | null {
  const bases = getBases(shape, symmetryMode, extraRotation)
  if (!bases) return null
  const n = bases.length
  return { n, period: (2 * Math.PI) / n, offsetAngle: Math.atan2(bases[0][1], bases[0][0]) }
}

export function binIndex(angle: number, bins: BinGeometry): number {
  const raw = Math.round((angle - bins.offsetAngle) / bins.period) % bins.n
  return raw < 0 ? raw + bins.n : raw
}

/** The single nearest of the shape's `n` discrete directions to `theta`. */
export function snapNearestAngle(theta: number, bins: BinGeometry): number {
  const k = Math.round((theta - bins.offsetAngle) / bins.period)
  return bins.offsetAngle + k * bins.period
}

/** The two adjacent allowed directions bracketing `theta` -- `thetaLo` is
 * the nearest one, `thetaHi` is the next one over on whichever side `theta`
 * leans. Degenerate only when `theta` lands exactly on `thetaLo` (then
 * `thetaHi` collapses onto it too) -- `decomposeBend` catches that via its
 * own parallel-direction guard. */
export function bracketAngles(theta: number, bins: BinGeometry): [number, number] {
  const nearest = snapNearestAngle(theta, bins)
  const rel = theta - nearest
  const thetaHi = nearest + Math.sign(rel) * bins.period
  return [nearest, thetaHi]
}

export interface BendConfig {
  legAngleFromA: number
  legAngleFromB: number
  bendPoint: Point
}

/** Decomposes the raw displacement `pb - pa` into components along the two
 * bracketing basis directions (`u1 = thetaLo`, `u2 = thetaHi`) via the
 * parallelogram rule `coeffA*u1 + coeffB*u2 = (dx,dy)`, then reads off the
 * two candidate bend configurations directly from that decomposition:
 * config 1 bends at `p1 = pa + coeffA*u1` (leg from A along u1, leg from B
 * along u2); config 2 bends at `p2 = pa + coeffB*u2` (swapped). Returns
 * `null` if `thetaLo`/`thetaHi` are (numerically) parallel -- `theta` is
 * already aligned with a single allowed direction, so a direct path is the
 * right tool instead. */
export function decomposeBend(pa: Point, pb: Point, thetaLo: number, thetaHi: number): [BendConfig, BendConfig] | null {
  const dx = pb.x - pa.x
  const dy = pb.y - pa.y
  const u1x = Math.cos(thetaLo)
  const u1y = Math.sin(thetaLo)
  const u2x = Math.cos(thetaHi)
  const u2y = Math.sin(thetaHi)
  const det = u1x * u2y - u1y * u2x
  if (Math.abs(det) < PARALLEL_EPS) return null
  const coeffA = (dx * u2y - dy * u2x) / det
  const coeffB = (dy * u1x - dx * u1y) / det

  const p1: Point = { x: pa.x + coeffA * u1x, y: pa.y + coeffA * u1y }
  const p2: Point = { x: pa.x + coeffB * u2x, y: pa.y + coeffB * u2y }

  const config1: BendConfig = {
    legAngleFromA: coeffA >= 0 ? thetaLo : thetaLo + Math.PI,
    legAngleFromB: coeffB >= 0 ? thetaHi + Math.PI : thetaHi,
    bendPoint: p1,
  }
  const config2: BendConfig = {
    legAngleFromA: coeffB >= 0 ? thetaHi : thetaHi + Math.PI,
    legAngleFromB: coeffA >= 0 ? thetaLo + Math.PI : thetaLo,
    bendPoint: p2,
  }
  return [config1, config2]
}

/** Default for `computePathOptions`'s `offerToleranceDeg` -- how close (in
 * degrees) a raw angle must be to a snap direction, or to the midpoint
 * between two snap directions, before a candidate path is hidden from the
 * picker as visually-ambiguous. User-tunable via
 * `hyperparams.tilingPathOfferToleranceDeg`; keep it comfortably under a
 * quarter of the tightest shape's period (dodecagon's 30°, i.e. under 7.5°)
 * or the picker can offer zero options for a rare worst-angle pair -- see
 * `computePathOptions`'s doc for why the default holds that margin. */
const DEFAULT_OFFER_TOLERANCE_DEG = 5

export type PathOption =
  | { kind: 'direct'; angle: number }
  | { kind: 'bend'; configIndex: 0 | 1; config: BendConfig }

/** The candidate paths worth offering between two vertices at their
 * *current* positions -- up to 3 (1 direct + 2 bend configs). A direct path
 * is offered only when the raw angle isn't uncomfortably close to a "mid"
 * angle (exactly between two snap directions, `period/2` away from the
 * nearest one) -- snapping there would silently pick an arbitrary, likely
 * misleading, direction. A bend is offered only when the raw angle isn't
 * already close enough to a snap direction that bending would be a
 * pointless, barely-visible detour. Both conditions can hold at once (the
 * common "clearly off-axis but not right at the worst angle" case) for
 * every shape here at the default tolerance, since `period/2 > 2 *
 * offerToleranceDeg` always holds (hexagon 30°, octagon 22.5°, dodecagon
 * 15°, square 45° half-periods vs. a 5°+5° carve-out) -- so this can
 * return 0, 1, 2, or 3 options, never requiring a forced fallback. Raising
 * `offerToleranceDeg` well past its default shrinks that margin (see
 * `DEFAULT_OFFER_TOLERANCE_DEG`'s doc) and can reintroduce the zero-option
 * case for a pair sitting at the worst angle. */
export function computePathOptions(
  pa: Point,
  pb: Point,
  bins: BinGeometry,
  offerToleranceDeg: number = DEFAULT_OFFER_TOLERANCE_DEG,
): PathOption[] {
  const theta = Math.atan2(pb.y - pa.y, pb.x - pa.x)
  const nearest = snapNearestAngle(theta, bins)
  const periodDeg = (bins.period * 180) / Math.PI
  const distToSnapDeg = Math.abs(((theta - nearest) * 180) / Math.PI)

  const options: PathOption[] = []
  if (distToSnapDeg < periodDeg / 2 - offerToleranceDeg) {
    options.push({ kind: 'direct', angle: nearest })
  }
  if (distToSnapDeg > offerToleranceDeg) {
    const [thetaLo, thetaHi] = bracketAngles(theta, bins)
    const decomposed = decomposeBend(pa, pb, thetaLo, thetaHi)
    decomposed?.forEach((config, i) => options.push({ kind: 'bend', configIndex: i as 0 | 1, config }))
  }
  return options
}

function orientation(p: Point, q: Point, r: Point): -1 | 0 | 1 {
  const val = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)
  if (Math.abs(val) < 1e-12) return 0
  return val > 0 ? 1 : -1
}

function onSegment(p: Point, q: Point, r: Point): boolean {
  const eps = 1e-9
  return (
    Math.min(p.x, r.x) - eps <= q.x &&
    q.x <= Math.max(p.x, r.x) + eps &&
    Math.min(p.y, r.y) - eps <= q.y &&
    q.y <= Math.max(p.y, r.y) + eps
  )
}

function pointsEqual(a: Point, b: Point): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-9
}

/** Proper-crossing test between segments `p1p2` and `p3p4` -- a shared
 * endpoint is normal (legs meeting at a vertex) and never counts as a
 * crossing; an endpoint of one segment landing on the *interior* of the
 * other does count (a T-touch is still a physically-impossible overlap). */
export function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  if (pointsEqual(p1, p3) || pointsEqual(p1, p4) || pointsEqual(p2, p3) || pointsEqual(p2, p4)) return false
  const o1 = orientation(p1, p2, p3)
  const o2 = orientation(p1, p2, p4)
  const o3 = orientation(p3, p4, p1)
  const o4 = orientation(p3, p4, p2)
  if (o1 !== o2 && o3 !== o4) return true
  if (o1 === 0 && onSegment(p1, p3, p2)) return true
  if (o2 === 0 && onSegment(p1, p4, p2)) return true
  if (o3 === 0 && onSegment(p3, p1, p4)) return true
  if (o4 === 0 && onSegment(p3, p2, p4)) return true
  return false
}

/** Standard monotone chain (Andrew's algorithm); no dependency needed for
 * input this small. Returns `null` for degenerate input (fewer than 3
 * points, or all collinear, i.e. no well-defined interior) -- callers each
 * have their own sensible fallback for that case (see `convexHullIds`/
 * `convexHullRing`), matching the backend's `_convex_hull_flap_ids` (which
 * falls back the same way on a `QhullError`). */
function computeHullRingPoints<T extends Point & { id: string }>(points: T[]): T[] | null {
  if (points.length < 3) return null
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const buildHalf = (pts: typeof sorted) => {
    const hull: typeof sorted = []
    for (const p of pts) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop()
      hull.push(p)
    }
    hull.pop()
    return hull
  }
  const lower = buildHalf(sorted)
  const upper = buildHalf([...sorted].reverse())
  const ring = [...lower, ...upper]
  return ring.length < 3 ? null : ring
}

/** Every id on the convex hull of `points` -- degenerate input (see
 * `computeHullRingPoints`) defensively counts every point as a hull point. */
export function convexHullIds(points: Array<{ id: string } & Point>): Set<string> {
  const ring = computeHullRingPoints(points)
  return new Set((ring ?? points).map((p) => p.id))
}

/** The convex hull's vertices in ring order (one trip around) -- needed to
 * walk hull *edges* (consecutive pairs), unlike `convexHullIds`'s plain
 * membership set. Degenerate input falls back to `points` in their given
 * order -- an arbitrary but harmless "ring" since there's no well-defined
 * hull to walk anyway. */
export function convexHullRing(points: Array<{ id: string } & Point>): string[] {
  const ring = computeHullRingPoints(points)
  return (ring ?? points).map((p) => p.id)
}

export function nearestEdge(p: Point): EdgeSide {
  const distances: Record<EdgeSide, number> = { left: p.x, right: 1 - p.x, bottom: p.y, top: 1 - p.y }
  let best: EdgeSide = 'left'
  let bestDist = distances.left
  for (const edge of Object.keys(distances) as EdgeSide[]) {
    if (distances[edge] < bestDist) {
      bestDist = distances[edge]
      best = edge
    }
  }
  return best
}

export function nearestEdgeRow(flapId: string, p: Point): Row {
  const edge = nearestEdge(p)
  if (edge === 'left') return { coeffs: { [columnKey(flapId, 'x')]: 1 }, b: 0 }
  if (edge === 'right') return { coeffs: { [columnKey(flapId, 'x')]: 1 }, b: 1 }
  if (edge === 'bottom') return { coeffs: { [columnKey(flapId, 'y')]: 1 }, b: 0 }
  return { coeffs: { [columnKey(flapId, 'y')]: 1 }, b: 1 }
}

/** The direction constraint for one leg: `n_hat . (vB - vA) = 0` where
 * `n_hat = (-sin(angle), cos(angle))` -- generalizes `tiling_solve.py`'s
 * `_direct_row` to any two vertex ids (flap or intermediate). Depends only
 * on the committed `angle`, never on the vertices' current positions. */
export function legRow(vertexAId: string, vertexBId: string, angle: number): Row {
  const nx = -Math.sin(angle)
  const ny = Math.cos(angle)
  return {
    coeffs: {
      [columnKey(vertexBId, 'x')]: nx,
      [columnKey(vertexAId, 'x')]: -nx,
      [columnKey(vertexBId, 'y')]: ny,
      [columnKey(vertexAId, 'y')]: -ny,
    },
    b: 0,
  }
}
