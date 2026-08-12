import type { Point } from './symmetry'

/** Straight-skeleton computation for a simple CCW polygon (a well-behaved
 * tiling face) via a hand-rolled wavefront simulation -- Felkel & Obdrzalek
 * style edge-collapse + reflex-vertex split events, recomputing all
 * candidate event times from scratch each iteration rather than a priority
 * queue (n is tiny here -- a handful to a couple dozen vertices -- so
 * simplicity/robustness beats asymptotic speed, and this must re-run every
 * drag frame). No dependency does this (`clipper2-ts` offsets polygons at a
 * fixed distance; it doesn't expose skeleton topology). Never throws: any
 * degenerate/non-converging input returns `null` so a single malformed face
 * can't break the rest of the tiling editor's rendering. */

const EPS_LENGTH = 1e-7
const EPS_PARALLEL = 1e-9
const EPS_TIME = 1e-9
const EPS_DENOM = 1e-6
const EPS_ANGLE = 1e-9

export interface OriginalEdge {
  a: Point
  b: Point
  dir: Point
  normal: Point
  length: number
}

export interface SkeletonRidge {
  start: Point
  end: Point
  startIsBoundary: boolean
  endIsBoundary: boolean
  /** True iff `start` is an original boundary vertex that is reflex/concave
   * -- callers render these blue, everything else red. */
  isReflexBoundary: boolean
}

export interface SkeletonNode {
  position: Point
  /** Indices into the returned `edges` array this node's incircle is
   * tangent to -- 3 generically, occasionally more only in an exact
   * co-circular multi-way tie (resolved here as sequential near-identical
   * events rather than one merged node; not required to fix). */
  tangentEdges: number[]
}

export interface StraightSkeletonResult {
  ridges: SkeletonRidge[]
  nodes: SkeletonNode[]
  edges: OriginalEdge[]
}

export interface Hinge {
  from: Point
  to: Point
  edgeIndex: number
}

interface WVertex {
  id: number
  pos: Point
  bisectorDir: Point
  leftEdge: number
  rightEdge: number
  birthTime: number
  prev: WVertex | null
  next: WVertex | null
  isOriginalVertex: boolean
  dead: boolean
}

function buildOriginalEdges(polygon: Point[]): OriginalEdge[] | null {
  const n = polygon.length
  const edges: OriginalEdge[] = []
  for (let i = 0; i < n; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % n]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = Math.hypot(dx, dy)
    if (length < EPS_LENGTH) return null
    const dir = { x: dx / length, y: dy / length }
    // Left-of-travel rotation (+90 deg CCW) -- the inward normal for a
    // CCW-wound polygon in this codebase's y-up convention.
    const normal = { x: -dir.y, y: dir.x }
    edges.push({ a, b, dir, normal, length })
  }
  return edges
}

/** Bisector velocity satisfying `v . nL = v . nR = 1` (NOT unit-length --
 * that's a common naive-implementation bug) so perpendicular distance to
 * both adjacent edge lines grows at exactly unit rate. Denominator ->0 at
 * either extreme of a very sharp vertex (near-0 or near-2*pi interior
 * angle); clamped rather than divided-by-near-zero, trading a bounded
 * approximation for guaranteed termination. */
function computeBisector(nL: Point, nR: Point): Point {
  let denom = 1 + nL.x * nR.x + nL.y * nR.y
  if (Math.abs(denom) < EPS_DENOM) denom = denom < 0 ? -EPS_DENOM : EPS_DENOM
  return { x: (nL.x + nR.x) / denom, y: (nL.y + nR.y) / denom }
}

function crossZ(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x
}

/** Reflex iff the turn from the left edge's direction to the right edge's
 * direction is clockwise -- works uniformly for seed and split-born
 * vertices alike, since it only depends on the two current edge indices. */
function isReflex(v: WVertex, edges: OriginalEdge[]): boolean {
  return crossZ(edges[v.leftEdge].dir, edges[v.rightEdge].dir) < -EPS_ANGLE
}

function relPos(v: WVertex, t: number): Point {
  return { x: v.pos.x + (t - v.birthTime) * v.bisectorDir.x, y: v.pos.y + (t - v.birthTime) * v.bisectorDir.y }
}

function dedupe(values: number[]): number[] {
  return Array.from(new Set(values))
}

/** Time at which adjacent active vertices `v` (left) and `w = v.next`
 * (right) meet -- solved as the time their positions' projections onto the
 * shared collapsing edge's direction coincide (the edge's remaining length
 * hits zero), which is well-posed with a single unknown, unlike naively
 * intersecting the two bisector rays as independent lines. */
function edgeCollapseTime(v: WVertex, w: WVertex, edges: OriginalEdge[]): number | null {
  const idx = v.rightEdge
  if (w.leftEdge !== idx) return null
  const dir = edges[idx].dir
  const svA = (v.pos.x - v.birthTime * v.bisectorDir.x) * dir.x + (v.pos.y - v.birthTime * v.bisectorDir.y) * dir.y
  const svB = v.bisectorDir.x * dir.x + v.bisectorDir.y * dir.y
  const swA = (w.pos.x - w.birthTime * w.bisectorDir.x) * dir.x + (w.pos.y - w.birthTime * w.bisectorDir.y) * dir.y
  const swB = w.bisectorDir.x * dir.x + w.bisectorDir.y * dir.y
  const denom = svB - swB
  if (Math.abs(denom) < EPS_PARALLEL) return null
  return (swA - svA) / denom
}

function withinSegment(hit: Point, a: Point, b: Point, dir: Point): boolean {
  const projHit = hit.x * dir.x + hit.y * dir.y
  const projA = a.x * dir.x + a.y * dir.y
  const projB = b.x * dir.x + b.y * dir.y
  const lo = Math.min(projA, projB) - EPS_LENGTH
  const hi = Math.max(projA, projB) + EPS_LENGTH
  return projHit >= lo && projHit <= hi
}

/** Time at which reflex vertex `v`'s bisector ray reaches the (still-live,
 * already-shrunk) extent of active edge `(u, w = u.next)` -- the most
 * common naive-implementation bug is validating against the ORIGINAL edge
 * extent instead of `u`/`w`'s current positions; `withinSegment` here uses
 * the live, time-evolved endpoints. */
function splitTime(v: WVertex, u: WVertex, w: WVertex, edges: OriginalEdge[]): number | null {
  if (u.rightEdge !== w.leftEdge) return null
  const idx = u.rightEdge
  if (idx === v.leftEdge || idx === v.rightEdge) return null
  const e = edges[idx]
  const c0 = (v.pos.x - v.birthTime * v.bisectorDir.x - e.a.x) * e.normal.x + (v.pos.y - v.birthTime * v.bisectorDir.y - e.a.y) * e.normal.y
  const c1 = v.bisectorDir.x * e.normal.x + v.bisectorDir.y * e.normal.y - 1
  if (Math.abs(c1) < EPS_PARALLEL) return null
  const t = -c0 / c1
  if (t < v.birthTime - EPS_TIME) return null
  const hit = relPos(v, t)
  const uAt = relPos(u, t)
  const wAt = relPos(w, t)
  if (!withinSegment(hit, uAt, wAt, e.dir)) return null
  return t
}

interface EdgeEventCandidate {
  kind: 'edge'
  time: number
  v: WVertex
  w: WVertex
}
interface SplitEventCandidate {
  kind: 'split'
  time: number
  v: WVertex
  u: WVertex
  w: WVertex
}
type EventCandidate = EdgeEventCandidate | SplitEventCandidate

/** On an exact tie (within `EPS_TIME`), prefer a split event over an edge
 * event -- applying a tied edge event first can merge away a vertex that a
 * tied split's future resolution actually depends on (observed on a
 * symmetric concave polygon during testing: an edge collapse and a split
 * landing at the exact same instant, where consuming the edge first left
 * the split's child vertex permanently paired with another vertex that had
 * also just gone motion-less, an unresolvable frozen pair). Processing the
 * split first keeps the edge event's participants around a little longer,
 * avoiding that specific failure mode; this is a heuristic, not a general
 * simultaneous-event solver -- exact multi-way ties can still fail
 * gracefully (return `null`) in harder configurations. */
function isBetterEvent(time: number, kind: 'edge' | 'split', best: EventCandidate | null): boolean {
  if (best === null) return true
  if (time < best.time - EPS_TIME) return true
  if (time > best.time + EPS_TIME) return false
  return kind === 'split' && best.kind === 'edge'
}

function findNextEvent(active: WVertex[], edges: OriginalEdge[], time: number): EventCandidate | null {
  let best: EventCandidate | null = null
  for (const v of active) {
    const w = v.next!
    if (w === v) continue
    const t = edgeCollapseTime(v, w, edges)
    if (t !== null && t >= time - EPS_TIME && isBetterEvent(t, 'edge', best)) {
      best = { kind: 'edge', time: Math.max(t, time), v, w }
    }
  }
  for (const v of active) {
    if (!isReflex(v, edges)) continue
    for (const u of active) {
      const w = u.next!
      if (u === v || w === v || w === u) continue
      const t = splitTime(v, u, w, edges)
      if (t !== null && t >= time - EPS_TIME && isBetterEvent(t, 'split', best)) {
        best = { kind: 'split', time: Math.max(t, time), v, u, w }
      }
    }
  }
  return best
}

function closeRidge(v: WVertex, endPos: Point, ridges: SkeletonRidge[], edges: OriginalEdge[]) {
  if (Math.hypot(endPos.x - v.pos.x, endPos.y - v.pos.y) < EPS_LENGTH) return
  ridges.push({
    start: v.pos,
    end: endPos,
    startIsBoundary: v.isOriginalVertex,
    endIsBoundary: false,
    isReflexBoundary: v.isOriginalVertex && isReflex(v, edges),
  })
}

function applyEdgeEvent(
  v: WVertex,
  w: WVertex,
  time: number,
  edges: OriginalEdge[],
  nodes: SkeletonNode[],
  ridges: SkeletonRidge[],
  makeId: () => number,
): WVertex {
  const pv = relPos(v, time)
  const pw = relPos(w, time)
  const pos = { x: (pv.x + pw.x) / 2, y: (pv.y + pw.y) / 2 }
  nodes.push({ position: pos, tangentEdges: dedupe([v.leftEdge, v.rightEdge, w.rightEdge]) })
  closeRidge(v, pos, ridges, edges)
  closeRidge(w, pos, ridges, edges)
  v.dead = true
  w.dead = true

  const left = v.prev!
  const right = w.next!
  const child: WVertex = {
    id: makeId(),
    pos,
    bisectorDir: computeBisector(edges[v.leftEdge].normal, edges[w.rightEdge].normal),
    leftEdge: v.leftEdge,
    rightEdge: w.rightEdge,
    birthTime: time,
    prev: left,
    next: right,
    isOriginalVertex: false,
    dead: false,
  }
  left.next = child
  right.prev = child
  return child
}

/** A split divides the wavefront at `v` and, geometrically, cuts the struck
 * edge's active pair `(u, w)` too -- reconnecting the two resulting open
 * chains through 2 new vertices generally produces TWO independent cyclic
 * loops (`v.prev -> leftChild -> w -> ... -> v.prev` and
 * `u -> rightChild -> v.next -> ... -> u`), matching a reflex vertex
 * genuinely pinching a simple polygon's wavefront into two separate
 * sub-fronts. Both loops keep being processed by the same event loop
 * afterward, independently, until each collapses on its own. */
function applySplitEvent(
  v: WVertex,
  u: WVertex,
  w: WVertex,
  time: number,
  edges: OriginalEdge[],
  nodes: SkeletonNode[],
  ridges: SkeletonRidge[],
  makeId: () => number,
): [WVertex, WVertex] {
  const pos = relPos(v, time)
  const struckIdx = u.rightEdge
  nodes.push({ position: pos, tangentEdges: dedupe([v.leftEdge, v.rightEdge, struckIdx]) })
  closeRidge(v, pos, ridges, edges)
  v.dead = true

  const leftChild: WVertex = {
    id: makeId(),
    pos,
    bisectorDir: computeBisector(edges[v.leftEdge].normal, edges[struckIdx].normal),
    leftEdge: v.leftEdge,
    rightEdge: struckIdx,
    birthTime: time,
    prev: v.prev!,
    next: w,
    isOriginalVertex: false,
    dead: false,
  }
  const rightChild: WVertex = {
    id: makeId(),
    pos,
    bisectorDir: computeBisector(edges[struckIdx].normal, edges[v.rightEdge].normal),
    leftEdge: struckIdx,
    rightEdge: v.rightEdge,
    birthTime: time,
    prev: u,
    next: v.next!,
    isOriginalVertex: false,
    dead: false,
  }
  v.prev!.next = leftChild
  w.prev = leftChild
  u.next = rightChild
  v.next!.prev = rightChild
  return [leftChild, rightChild]
}

const EPS_VELOCITY = 1e-4

/** Terminal case: a loop has shrunk to exactly 2 mutually-adjacent active
 * vertices. Usually they meet at one final point (a fact guaranteed for any
 * simple polygon's wavefront: 3 active vertices' bisectors are always
 * concurrent, by the same reasoning a triangle's 3 angle bisectors meet at
 * its incenter, so the pair remaining after the 3rd collapses is already
 * at, or about to reach, a shared point) -- falls back to the vertices'
 * current positions when `edgeCollapseTime` is itself degenerate (e.g.
 * exactly-parallel-opposite remaining edges, as in a perfectly symmetric
 * input) and they're already coincident, no further time needed.
 *
 * A DIFFERENT degenerate case -- common for rectilinear polygons (square
 * and octagon tiling faces have plenty of exact 90 deg notches): a vertex
 * bounding two exactly-antiparallel edges has zero bisector velocity by
 * construction (`computeBisector`'s denominator is `1 + nL.nR = 1 + (-1) =
 * 0`). Two SEPARATE such frozen vertices, born from unrelated earlier
 * events, can end up adjacent to each other without ever having a chance to
 * converge -- there is no future meeting time, but they are also not
 * already coincident. Both already have their own valid `SkeletonNode`
 * (recorded when each was born), so the correct resolution is simply a
 * straight ridge connecting their two fixed positions directly, with no
 * additional node. Returns false only when neither of these applies. */
function finalizeTwoLoop(v: WVertex, w: WVertex, time: number, edges: OriginalEdge[], nodes: SkeletonNode[], ridges: SkeletonRidge[]): boolean {
  const meetTime = edgeCollapseTime(v, w, edges)
  if (meetTime !== null && meetTime >= time - EPS_TIME) {
    const t = Math.max(meetTime, time)
    const pv = relPos(v, t)
    const pw = relPos(w, t)
    const pos = { x: (pv.x + pw.x) / 2, y: (pv.y + pw.y) / 2 }
    nodes.push({ position: pos, tangentEdges: dedupe([v.leftEdge, v.rightEdge, w.rightEdge]) })
    closeRidge(v, pos, ridges, edges)
    closeRidge(w, pos, ridges, edges)
    v.dead = true
    w.dead = true
    return true
  }

  const pv = relPos(v, time)
  const pw = relPos(w, time)
  if (Math.hypot(pv.x - pw.x, pv.y - pw.y) < EPS_LENGTH * 10) {
    const pos = { x: (pv.x + pw.x) / 2, y: (pv.y + pw.y) / 2 }
    nodes.push({ position: pos, tangentEdges: dedupe([v.leftEdge, v.rightEdge, w.rightEdge]) })
    closeRidge(v, pos, ridges, edges)
    closeRidge(w, pos, ridges, edges)
    v.dead = true
    w.dead = true
    return true
  }

  const vFrozen = Math.hypot(v.bisectorDir.x, v.bisectorDir.y) < EPS_VELOCITY
  const wFrozen = Math.hypot(w.bisectorDir.x, w.bisectorDir.y) < EPS_VELOCITY
  if (vFrozen && wFrozen) {
    // Both already have their own node (from their own birth event) --
    // just the direct connecting ridge is missing, recorded once (not
    // once per endpoint, which would double it up).
    closeRidge(v, pw, ridges, edges)
    v.dead = true
    w.dead = true
    return true
  }

  return false
}

/** An exact co-circular multi-way tie (e.g. a perfectly symmetric square,
 * whose 4 corners meet at the center simultaneously) gets resolved above as
 * several sequential same-position events rather than one merged node --
 * cheap to clean up here since ridges reference raw points, not node
 * indices, so merging nodes never requires touching `ridges`. */
function mergeCoincidentNodes(nodes: SkeletonNode[]): SkeletonNode[] {
  const merged: SkeletonNode[] = []
  for (const node of nodes) {
    const existing = merged.find((m) => Math.hypot(m.position.x - node.position.x, m.position.y - node.position.y) < EPS_LENGTH)
    if (existing) existing.tangentEdges = dedupe([...existing.tangentEdges, ...node.tangentEdges])
    else merged.push({ position: node.position, tangentEdges: [...node.tangentEdges] })
  }
  return merged
}

export function computeStraightSkeleton(polygon: Point[]): StraightSkeletonResult | null {
  const n = polygon.length
  if (n < 3) return null
  const edges = buildOriginalEdges(polygon)
  if (!edges) return null

  let nextId = 0
  const seeds: WVertex[] = polygon.map((p, i) => {
    const leftEdge = (i - 1 + n) % n
    const rightEdge = i
    return {
      id: nextId++,
      pos: { x: p.x, y: p.y },
      bisectorDir: computeBisector(edges[leftEdge].normal, edges[rightEdge].normal),
      leftEdge,
      rightEdge,
      birthTime: 0,
      prev: null,
      next: null,
      isOriginalVertex: true,
      dead: false,
    }
  })
  for (let i = 0; i < n; i++) {
    seeds[i].next = seeds[(i + 1) % n]
    seeds[i].prev = seeds[(i - 1 + n) % n]
  }

  let active: WVertex[] = seeds
  const nodes: SkeletonNode[] = []
  const ridges: SkeletonRidge[] = []
  const maxIterations = 4 * n + 16
  let iterations = 0
  let time = 0

  while (true) {
    for (const v of active) {
      if (v.dead) continue
      const w = v.next!
      if (w !== v && !w.dead && w.next === v) {
        if (!finalizeTwoLoop(v, w, time, edges, nodes, ridges)) return null
      }
    }
    active = active.filter((v) => !v.dead)
    if (active.length === 0) break
    if (active.length < 3) return null // corrupted/unresolved leftover -- bail gracefully

    if (iterations++ > maxIterations) return null
    const event = findNextEvent(active, edges, time)
    if (!event) return null
    time = Math.max(time, event.time)
    if (event.kind === 'edge') {
      active.push(applyEdgeEvent(event.v, event.w, time, edges, nodes, ridges, () => nextId++))
    } else {
      active.push(...applySplitEvent(event.v, event.u, event.w, time, edges, nodes, ridges, () => nextId++))
    }
  }

  return { ridges, nodes: mergeCoincidentNodes(nodes), edges }
}

export function computeHinges(nodes: SkeletonNode[], edges: OriginalEdge[]): Hinge[] {
  const hinges: Hinge[] = []
  for (const node of nodes) {
    for (const edgeIndex of node.tangentEdges) {
      const e = edges[edgeIndex]
      const abx = e.b.x - e.a.x
      const aby = e.b.y - e.a.y
      const lenSq = abx * abx + aby * aby
      if (lenSq < EPS_LENGTH * EPS_LENGTH) continue
      // Deliberately NOT clamped to [0, 1]: in a concave polygon, a node's
      // incircle can be tangent to an edge's infinite LINE at a point that
      // falls outside that edge's actual finite segment (the edge is too
      // short, or off-center, to reach the true tangent point) -- the
      // node's tangency to that edge is still real, just via its
      // extension. `to` here exists only to give a hinge its direction
      // (see `castHingeRay`'s caller, which derives an angle from `to -
      // from` and otherwise ignores `to`'s position), and that direction
      // must stay exactly perpendicular to the edge regardless of where
      // the foot lands -- clamping would instead point toward the nearest
      // endpoint, an arbitrary (non-perpendicular, non-45-degree-multiple)
      // direction with no relation to the tangency this hinge represents.
      const tParam = ((node.position.x - e.a.x) * abx + (node.position.y - e.a.y) * aby) / lenSq
      hinges.push({ from: node.position, to: { x: e.a.x + tParam * abx, y: e.a.y + tParam * aby }, edgeIndex })
    }
  }
  return hinges
}
