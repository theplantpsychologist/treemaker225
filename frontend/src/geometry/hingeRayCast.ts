import type { Point } from './symmetry'

/**
 * Extends a straight-skeleton hinge past its immediate tangent side into a
 * full reflected light-ray path, mirroring `prototypes/cp225.py`'s
 * `Cp225.ray_cast` -- adapted from that prototype's 22.5-degree-quantized
 * exact arithmetic to plain floating-point angles/segments, since this
 * editor's tiling graph is continuous (arbitrary shape bases, dragged
 * positions), not snapped to a fixed integer lattice.
 *
 * The physical picture: a hinge crease doesn't just touch the nearest
 * polygon side and stop -- folding it flat requires the crease to keep
 * going, bouncing (mirror-reflecting) off whatever line it meets next
 * (another crease leg, or another face's own skeleton ridge), until it
 * either runs off the physical paper (the unit square) or arrives at a
 * point that's already a real vertex -- at which point the two sides of
 * the paper it's folding between are already reconciled there, and no
 * further crease is needed.
 */

const EPS_FORWARD = 1e-9
const EPS_PARALLEL = 1e-9
const EPS_SEGMENT = 1e-9

export interface MirrorSegment {
  a: Point
  b: Point
}

/** A `MirrorSegment` with its edge vector precomputed -- `castHingeRay` is
 * called once per hinge, and every call re-scans the *same* `mirrors` array
 * across up to `maxBounces` iterations, so recomputing `b - a` from scratch
 * inside the innermost intersection test (as this used to) redid the same
 * subtraction O(hinges * bounces) times per render for a value that's
 * actually constant for the whole render. `prepareMirrors` computes it
 * once per render instead; callers that rebuild their mirror list only on
 * topology/position changes (see `TilingEditorCanvas.tsx`) get the full
 * benefit by preparing once and reusing the result across every hinge. */
export interface PreparedMirror {
  a: Point
  b: Point
  ex: number
  ey: number
}

export function prepareMirrors(segments: MirrorSegment[]): PreparedMirror[] {
  return segments.map((s) => ({ a: s.a, b: s.b, ex: s.b.x - s.a.x, ey: s.b.y - s.a.y }))
}

function normalizeAngle(theta: number): number {
  let t = theta % (2 * Math.PI)
  if (t <= -Math.PI) t += 2 * Math.PI
  if (t > Math.PI) t -= 2 * Math.PI
  return t
}

/**
 * Crease-vertex reflection -- NOT a physical light-ray bounce. A hinge
 * crossing a crease line must make the point it crosses flat-foldable
 * (satisfy Kawasaki's theorem): the incoming hinge ray-from-the-vertex
 * (pointing back where it came from, `incoming + pi`) and the outgoing
 * hinge ray must be mirror images of each other across the crease line,
 * so that line's two alternating angle pairs match up. That means the ray
 * keeps travelling forward across the line into the far side (like
 * transmission), not bouncing back into the side it came from (like a
 * physical mirror) -- a ray hitting the crease dead-on (normal incidence)
 * passes straight through unchanged, and one hitting at 45 degrees to a
 * horizontal crease exits at 45 degrees on the OTHER side of vertical
 * (e.g. up-right in, up-left out), not the physically-reflected up-right
 * bounced back to down-right.
 *
 * Derivation: mirroring the backward ray (`incoming + pi`) across the
 * line (angle `mirrorAngle`) gives `2*mirrorAngle - (incoming + pi)`;
 * that's the outgoing crease's own ray-from-the-vertex direction, which
 * IS the forward travel direction, since it already points away from the
 * vertex on the far side.
 */
function reflectAngle(incoming: number, mirrorAngle: number): number {
  return normalizeAngle(2 * mirrorAngle - incoming - Math.PI)
}

/** Forward intersection of the ray `origin + t*(cos angle, sin angle)`,
 * `t > 0`, with the finite segment `mirror.a` to `mirror.b`. Returns `null`
 * if the ray is parallel to the segment, the intersection falls behind the
 * ray's origin, or it falls outside the segment's own extent. */
function rayIntersectSegment(origin: Point, angle: number, mirror: PreparedMirror): { point: Point; t: number } | null {
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  const { a, ex, ey } = mirror
  const denom = dx * ey - dy * ex
  if (Math.abs(denom) < EPS_PARALLEL) return null
  const ax = a.x - origin.x
  const ay = a.y - origin.y
  const t = (ax * ey - ay * ex) / denom
  if (t < EPS_FORWARD) return null
  const s = (ax * dy - ay * dx) / denom
  if (s < -EPS_SEGMENT || s > 1 + EPS_SEGMENT) return null
  return { point: { x: origin.x + t * dx, y: origin.y + t * dy }, t }
}

/** Index of the first point in `vertices` within `eps` of `p`, or `-1` if
 * none -- the index (not just a boolean) lets `castHingeRay` report exactly
 * which vertex a hinge terminated at. */
function nearAnyVertexIndex(p: Point, vertices: Point[], eps: number): number {
  for (let i = 0; i < vertices.length; i++) {
    if (Math.hypot(vertices[i].x - p.x, vertices[i].y - p.y) < eps) return i
  }
  return -1
}

const EPS_BOUNDARY = 1e-6

/** True iff `p` sits on the physical unit-square edge -- checked directly
 * on the winning hit point's own coordinates rather than by which
 * candidate list produced it, because a boundary-anchored flap's own legs
 * routinely run exactly along the square's edge (e.g. a "pin to left edge"
 * flap's legs at x=0): the leg and the boundary segment are then the same
 * line, and floating-point tie-breaking between two lists searched
 * separately can't be trusted to prefer the boundary -- this coordinate
 * check catches that case regardless of which list "won". Note that when
 * the winning candidate was actually a `leg` (not the `boundary` list
 * itself), the leg crossing is still real and gets recorded as a bounce
 * before the ray terminates -- see the call site below. */
function isPointOnSquareBoundary(p: Point): boolean {
  return p.x <= EPS_BOUNDARY || p.x >= 1 - EPS_BOUNDARY || p.y <= EPS_BOUNDARY || p.y >= 1 - EPS_BOUNDARY
}

/** One reflection point along a cast hinge ray -- `mirrorKind`/`mirrorIndex`
 * identify exactly which segment (in the caller's own `legMirrors` or
 * `ridgeMirrors` array) was hit, so a caller building `HingeChain`s (see
 * `geometry/hingeChains.ts`) can map a `'leg'` bounce back to a real
 * tiling-graph leg id without re-deriving the intersection. */
export interface HingeBounce {
  point: Point
  mirrorKind: 'leg' | 'ridge'
  mirrorIndex: number
}

export type HingeTermination =
  | { kind: 'vertex'; vertexIndex: number }
  | { kind: 'boundary' }
  | { kind: 'maxBounces' }

export interface HingeRayResult {
  /** Full polyline traced, starting with `origin` -- same shape rendering
   * always used, kept as a flat array for that reason. */
  points: Point[]
  /** One entry per point in `points.slice(1)` where the ray crossed a leg
   * or a ridge. Usually one shorter than `points.slice(1)` -- a plain
   * `boundary`-list hit (no mirror at all) or a `vertex` termination
   * contributes a point with no corresponding bounce -- EXCEPT when the
   * ray's final point is a leg/ridge that happens to coincide with the
   * physical paper edge (see `castHingeRay`'s boundary-check above): that
   * crossing is still real and gets its own trailing bounce entry even
   * though the ray stops right there, so a caller mapping bounces to
   * "what comes next" (e.g. `geometry/hingeChains.ts`'s `angleAfter`) must
   * not assume a following point always exists. */
  bounces: HingeBounce[]
  termination: HingeTermination
}

/**
 * Cast a ray from `origin` in direction `initialAngle`, reflecting off
 * whichever of `legMirrors`/`ridgeMirrors` (tiling legs and straight-
 * skeleton ridges, kept as two separate arrays purely so bounces can be
 * tagged with a real, resolvable identity -- see `HingeBounce`) it hits
 * nearest at each step, until it either exits through one of `boundary`'s
 * segments (the physical edge of the paper) or lands within `vertexEps` of
 * any point in `vertices` (an existing tiling vertex or skeleton node, of
 * any kind) -- whichever comes first. Capped at `maxBounces` (see
 * `hyperparams.tilingMaxHingeBounces`) so a degenerate/near-parallel
 * configuration -- or a genuinely unresolved "billiard" reflection path
 * that never reaches a vertex or the boundary -- can't hang the render
 * loop; the partial path traced so far is returned (`termination.kind ===
 * 'maxBounces'`) rather than throwing.
 *
 * `origin` itself is expected to already be one of the entries in
 * `vertices` (every hinge's source IS a real skeleton vertex) -- rather
 * than asking the caller to filter it out, the very first bounce alone
 * (`bounce === 0`) ignores a landed-on-origin match, since a fresh
 * `t ~ 0+epsilon` self-intersection with one of the origin's own adjacent
 * mirrors (which literally share that point as an endpoint) would
 * otherwise truncate every hinge to a useless zero-length stub. Every
 * later bounce treats the origin as an ordinary vertex like any other, so
 * a hinge that genuinely loops back around to near its own source (or
 * passes near a different vertex) correctly stops there instead of
 * sailing through it.
 */
export function castHingeRay(
  origin: Point,
  initialAngle: number,
  legMirrors: PreparedMirror[],
  ridgeMirrors: PreparedMirror[],
  boundary: PreparedMirror[],
  vertices: Point[],
  vertexEps: number,
  maxBounces: number,
): HingeRayResult {
  const points: Point[] = [origin]
  const bounces: HingeBounce[] = []
  let current = origin
  let angle = initialAngle
  let skipKind: 'leg' | 'ridge' | null = null
  let skipIndex = -1

  for (let bounce = 0; bounce < maxBounces; bounce++) {
    let bestT = Infinity
    let bestPoint: Point | null = null
    let bestKind: 'leg' | 'ridge' | 'boundary' = 'boundary'
    let bestIndex = -1

    for (let i = 0; i < legMirrors.length; i++) {
      if (skipKind === 'leg' && i === skipIndex) continue
      const hit = rayIntersectSegment(current, angle, legMirrors[i])
      if (hit && hit.t < bestT) {
        bestT = hit.t
        bestPoint = hit.point
        bestKind = 'leg'
        bestIndex = i
      }
    }
    for (let i = 0; i < ridgeMirrors.length; i++) {
      if (skipKind === 'ridge' && i === skipIndex) continue
      const hit = rayIntersectSegment(current, angle, ridgeMirrors[i])
      if (hit && hit.t < bestT) {
        bestT = hit.t
        bestPoint = hit.point
        bestKind = 'ridge'
        bestIndex = i
      }
    }
    for (const seg of boundary) {
      const hit = rayIntersectSegment(current, angle, seg)
      if (hit && hit.t < bestT) {
        bestT = hit.t
        bestPoint = hit.point
        bestKind = 'boundary'
        bestIndex = -1
      }
    }

    if (!bestPoint) break // nothing ahead -- shouldn't happen, the boundary always bounds the space

    points.push(bestPoint)

    if (isPointOnSquareBoundary(bestPoint)) {
      // A leg (or ridge) that runs exactly along the physical paper edge --
      // e.g. a boundary-pinned flap's own leg -- is simultaneously a real
      // crossing AND the point where there's no paper left to transmit
      // into. The crossing itself is still genuine (a hinge-chain lock's
      // "common leg" search needs to see it -- see `geometry/hingeChains.ts`),
      // so record the bounce before terminating, rather than discarding it
      // the way a bare boundary-list hit (no mirror at all) does.
      if (bestKind === 'leg' || bestKind === 'ridge') {
        bounces.push({ point: bestPoint, mirrorKind: bestKind, mirrorIndex: bestIndex })
      }
      return { points, bounces, termination: { kind: 'boundary' } }
    }

    const vertexIndex = nearAnyVertexIndex(bestPoint, vertices, vertexEps)
    if (vertexIndex !== -1) {
      const matchIsOrigin = Math.hypot(vertices[vertexIndex].x - origin.x, vertices[vertexIndex].y - origin.y) < vertexEps
      if (!(bounce === 0 && matchIsOrigin)) {
        return { points, bounces, termination: { kind: 'vertex', vertexIndex } }
      }
    }

    if (bestKind === 'boundary') {
      // The winning candidate came from the boundary list but its point
      // isn't (numerically) on the boundary -- shouldn't happen since
      // those segments ARE the square's edges, but there's no mirror to
      // reflect off here either way, so stop rather than loop in place.
      return { points, bounces, termination: { kind: 'boundary' } }
    }

    bounces.push({ point: bestPoint, mirrorKind: bestKind, mirrorIndex: bestIndex })
    const mirror = bestKind === 'leg' ? legMirrors[bestIndex] : ridgeMirrors[bestIndex]
    angle = reflectAngle(angle, Math.atan2(mirror.ey, mirror.ex))
    current = bestPoint
    skipKind = bestKind
    skipIndex = bestIndex
  }

  return { points, bounces, termination: { kind: 'maxBounces' } }
}
