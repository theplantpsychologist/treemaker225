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

function nearAnyVertex(p: Point, vertices: Point[], eps: number): boolean {
  return vertices.some((v) => Math.hypot(v.x - p.x, v.y - p.y) < eps)
}

const EPS_BOUNDARY = 1e-6

/** True iff `p` sits on the physical unit-square edge -- checked directly
 * on the winning hit point's own coordinates rather than by which
 * candidate list produced it, because a boundary-anchored flap's own legs
 * routinely run exactly along the square's edge (e.g. a "pin to left edge"
 * flap's legs at x=0): the leg and the boundary segment are then the same
 * line, and floating-point tie-breaking between two lists searched
 * separately can't be trusted to prefer the boundary -- this coordinate
 * check catches that case regardless of which list "won". */
function isPointOnSquareBoundary(p: Point): boolean {
  return p.x <= EPS_BOUNDARY || p.x >= 1 - EPS_BOUNDARY || p.y <= EPS_BOUNDARY || p.y >= 1 - EPS_BOUNDARY
}

/**
 * Cast a ray from `origin` in direction `initialAngle`, reflecting off
 * whichever `mirrors` segment (a tiling leg or a straight-skeleton ridge)
 * it hits nearest at each step, until it either exits through one of
 * `boundary`'s segments (the physical edge of the paper) or lands within
 * `vertexEps` of any point in `vertices` (an existing tiling vertex or
 * skeleton node, of any kind) -- whichever comes first. Returns the full
 * polyline traced, starting with `origin`. Capped at `maxBounces` (see
 * `hyperparams.tilingMaxHingeBounces`) so a degenerate/near-parallel
 * configuration -- or a genuinely unresolved "billiard" reflection path
 * that never reaches a vertex or the boundary -- can't hang the render
 * loop; the partial path traced so far is returned rather than throwing.
 */
export function castHingeRay(
  origin: Point,
  initialAngle: number,
  mirrors: PreparedMirror[],
  boundary: PreparedMirror[],
  vertices: Point[],
  vertexEps: number,
  maxBounces: number,
): Point[] {
  const points: Point[] = [origin]
  let current = origin
  let angle = initialAngle
  let skipIndex = -1

  for (let bounce = 0; bounce < maxBounces; bounce++) {
    let bestT = Infinity
    let bestPoint: Point | null = null
    let bestMirrorIndex = -1

    for (let i = 0; i < mirrors.length; i++) {
      if (i === skipIndex) continue
      const hit = rayIntersectSegment(current, angle, mirrors[i])
      if (hit && hit.t < bestT) {
        bestT = hit.t
        bestPoint = hit.point
        bestMirrorIndex = i
      }
    }
    for (const seg of boundary) {
      const hit = rayIntersectSegment(current, angle, seg)
      if (hit && hit.t < bestT) {
        bestT = hit.t
        bestPoint = hit.point
        bestMirrorIndex = -1
      }
    }

    if (!bestPoint) break // nothing ahead -- shouldn't happen, the boundary always bounds the space

    points.push(bestPoint)
    if (isPointOnSquareBoundary(bestPoint) || nearAnyVertex(bestPoint, vertices, vertexEps)) break

    const mirror = mirrors[bestMirrorIndex]
    angle = reflectAngle(angle, Math.atan2(mirror.ey, mirror.ex))
    current = bestPoint
    skipIndex = bestMirrorIndex
  }

  return points
}
