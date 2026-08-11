import { nanoid } from 'nanoid'
import { fetchTilingSnap } from '../../api/client'
import type { ConstraintsState, CornerId, EdgeSide, LeafConstraint } from '../../types/constraints'
import { NO_LEAF_CONSTRAINT } from '../../types/constraints'
import type { HyperparamsState } from '../../types/hyperparams'
import type { TreeState } from '../../types/tree'
import { toTreeIn } from '../../types/tree'
import type { FrozenHullPin, TilingGraphState, TilingLeg, TilingPathCandidates, TilingVertex } from '../../types/tilingGraph'
import type { PathOption } from '../../geometry/tilingGraphOps'
import type { Point } from '../../geometry/symmetry'
import { getLeaves } from '../../geometry/treeGeometry'
import { extraRotationFor } from '../../geometry/shapes'
import { buildBaseRows } from '../../geometry/tilingBaseRows'
import {
  collectResolvedPoints,
  findAnyCollision,
  findPointCollision,
  isFullyFixedBySymmetryBoundary,
  resolveLeafConstraint,
} from '../../geometry/constraintResolution'
import {
  withClearedBoundary,
  withClearedLock,
  withClearedSymmetry,
  withLocked,
  withPinCorner,
  withPinEdge,
  withPinSymmetry,
} from './constraintActions'
import {
  type BinGeometry,
  binIndex,
  bracketAngles,
  computePathOptions,
  convexHullRing,
  decomposeBend,
  getBinGeometry,
  legRow,
  nearestEdge,
  nearestEdgeRow,
  segmentsIntersect,
  snapNearestAngle,
} from '../../geometry/tilingGraphOps'
import {
  buildColumnIndex,
  columnKey,
  minNormSolve2xK,
  nullSpaceBasis,
  solveMinPerturbation,
  tryAccept,
  type ColumnIndex,
  type Row,
} from '../../geometry/tilingLinAlg'

/** Pure orchestration for the manual tiling editor's graph-mutating
 * operations -- mirrors the `state/actions/packingActions.ts` split (pure
 * functions over plain data, called by thin `state/store.ts` actions).
 * Every operation here is synchronous, client-side linear algebra (see
 * `geometry/tilingLinAlg.ts`'s module doc for why) EXCEPT `seedTilingGraph`,
 * which makes one best-effort network call to suggest an initial path set
 * (see its own doc) -- everything after seeding stays fully synchronous, so
 * the editor stays responsive frame-to-frame.
 *
 * A hard invariant every function here maintains: a `TilingLeg`'s `angle`
 * is set once, at the moment the leg is created, and is *never*
 * recomputed from position afterward. Every row `legRow` builds depends
 * only on that stored angle, never on where its endpoints currently sit --
 * so no sequence of rank-checked additions, deletions, or (critically)
 * bounded null-space motion (drag, or the boundary pull-in below) can ever
 * change a leg's committed direction, even when an endpoint is dragged hard
 * against a corner. */

type Result<T> = { graph: T } | { error: string }

function binsFor(hyperparams: HyperparamsState, constraints: ConstraintsState): BinGeometry | null {
  const extraRotation = extraRotationFor(
    hyperparams.shape,
    hyperparams.hexagonExtraRotation,
    hyperparams.squareExtraRotation,
    hyperparams.dodecagonExtraRotation,
  )
  return getBinGeometry(hyperparams.shape, constraints.symmetryMode, extraRotation)
}

function frozenHullPinRow(pin: FrozenHullPin): Row {
  if (pin.edge === 'left') return { coeffs: { [columnKey(pin.flapId, 'x')]: 1 }, b: 0 }
  if (pin.edge === 'right') return { coeffs: { [columnKey(pin.flapId, 'x')]: 1 }, b: 1 }
  if (pin.edge === 'bottom') return { coeffs: { [columnKey(pin.flapId, 'y')]: 1 }, b: 0 }
  return { coeffs: { [columnKey(pin.flapId, 'y')]: 1 }, b: 1 }
}

function allBaseRows(graph: TilingGraphState, tree: TreeState): Row[] {
  return [...buildBaseRows(getLeaves(tree), graph.constraints), ...graph.frozenHullPins.map(frozenHullPinRow)]
}

function legRows(graph: TilingGraphState): Row[] {
  return Object.values(graph.legs).map((leg) => legRow(leg.vertexA, leg.vertexB, leg.angle))
}

function flattenPositions(vertexIds: string[], columns: ColumnIndex, vertices: Record<string, TilingVertex>): number[] {
  const x0 = new Array(columns.nCols).fill(0)
  for (const id of vertexIds) {
    x0[columns.index[columnKey(id, 'x')]] = vertices[id].x
    x0[columns.index[columnKey(id, 'y')]] = vertices[id].y
  }
  return x0
}

function unflattenPositions(vertexIds: string[], columns: ColumnIndex, solved: number[]): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {}
  for (const id of vertexIds) {
    out[id] = { x: solved[columns.index[columnKey(id, 'x')]], y: solved[columns.index[columnKey(id, 'y')]] }
  }
  return out
}

function applyPositions(
  vertices: Record<string, TilingVertex>,
  positions: Record<string, { x: number; y: number }>,
): Record<string, TilingVertex> {
  const out: Record<string, TilingVertex> = {}
  for (const [id, v] of Object.entries(vertices)) {
    const p = positions[id]
    out[id] = p ? { ...v, x: p.x, y: p.y } : v
  }
  return out
}

function legAngleAtVertex(leg: TilingLeg, vertexId: string): number {
  return leg.vertexA === vertexId ? leg.angle : leg.angle + Math.PI
}

function otherEndpoint(leg: TilingLeg, vertexId: string): string {
  return leg.vertexA === vertexId ? leg.vertexB : leg.vertexA
}

/** The existing leg (if any) already occupying `vertexId`'s direction-bin
 * for `angle` -- the slot-exclusivity/merge-detection primitive every
 * add-leg operation checks first. */
function occupiedLegAt(legs: Record<string, TilingLeg>, vertexId: string, bins: BinGeometry, angle: number): TilingLeg | undefined {
  const targetBin = binIndex(angle, bins)
  return Object.values(legs).find((leg) => {
    if (leg.vertexA !== vertexId && leg.vertexB !== vertexId) return false
    return binIndex(legAngleAtVertex(leg, vertexId), bins) === targetBin
  })
}

function segmentCrossesAny(
  existingLegs: TilingLeg[],
  candidateLegs: Array<{ vertexA: string; vertexB: string }>,
  positions: Record<string, { x: number; y: number }>,
): boolean {
  for (const candidate of candidateLegs) {
    const p1 = positions[candidate.vertexA]
    const p2 = positions[candidate.vertexB]
    for (const other of existingLegs) {
      const p3 = positions[other.vertexA]
      const p4 = positions[other.vertexB]
      if (segmentsIntersect(p1, p2, p3, p4)) return true
    }
  }
  return false
}

interface DerivedFields {
  dof: number
  freeAxes: Record<string, { x: boolean; y: boolean }>
  nullSpaceBasis: Array<Record<string, { dx: number; dy: number }>>
}

const FREE_AXIS_EPS = 1e-6

function deriveFields(rows: Row[], vertexIds: string[]): DerivedFields {
  const columns = buildColumnIndex(vertexIds)
  const basis = nullSpaceBasis(rows, columns)
  const freeAxes: Record<string, { x: boolean; y: boolean }> = {}
  const basisOut: Array<Record<string, { dx: number; dy: number }>> = basis.map(() => ({}))

  for (const id of vertexIds) {
    const xi = columns.index[columnKey(id, 'x')]
    const yi = columns.index[columnKey(id, 'y')]
    let xFree = false
    let yFree = false
    basis.forEach((vec, i) => {
      basisOut[i][id] = { dx: vec[xi], dy: vec[yi] }
      if (Math.abs(vec[xi]) > FREE_AXIS_EPS) xFree = true
      if (Math.abs(vec[yi]) > FREE_AXIS_EPS) yFree = true
    })
    freeAxes[id] = { x: xFree, y: yFree }
  }
  return { dof: basis.length, freeAxes, nullSpaceBasis: basisOut }
}

function fitNullSpaceCoefficients(
  basis: Array<Record<string, { dx: number; dy: number }>>,
  vertexId: string,
  desired: { dx: number; dy: number },
): number[] {
  const bx = basis.map((vec) => vec[vertexId]?.dx ?? 0)
  const by = basis.map((vec) => vec[vertexId]?.dy ?? 0)
  return minNormSolve2xK(bx, by, desired)
}

function fullDeltaFromCoefficients(
  vertexIds: string[],
  basis: Array<Record<string, { dx: number; dy: number }>>,
  coeffs: number[],
): Record<string, { dx: number; dy: number }> {
  const delta: Record<string, { dx: number; dy: number }> = {}
  for (const id of vertexIds) {
    let dx = 0
    let dy = 0
    coeffs.forEach((c, i) => {
      const comp = basis[i][id]
      if (!comp) return
      dx += c * comp.dx
      dy += c * comp.dy
    })
    delta[id] = { dx, dy }
  }
  return delta
}

/** The largest `t in [0,1]` such that applying `t * delta` to every vertex
 * keeps every one of them inside `[0,1]^2`. Scaling a null-space vector by
 * any scalar keeps it in the null space (`A(t*v) = t*(Av) = 0`), so this is
 * the *only* way to respect the square's boundary without ever perturbing
 * a leg's committed angle -- clamping coordinates independently (the old,
 * wrong approach) changes each vertex by a different amount and silently
 * breaks the shared-leg angle invariant between them. */
function computeMaxBoundedScale(vertices: Record<string, TilingVertex>, delta: Record<string, { dx: number; dy: number }>): number {
  let t = 1
  for (const [id, d] of Object.entries(delta)) {
    const v = vertices[id]
    if (!v) continue
    for (const [pos, dd] of [
      [v.x, d.dx],
      [v.y, d.dy],
    ] as const) {
      if (dd > 1e-12) t = Math.min(t, Math.max(0, (1 - pos) / dd))
      else if (dd < -1e-12) t = Math.min(t, Math.max(0, -pos / dd))
    }
  }
  return t
}

function applyScaledDelta(
  vertices: Record<string, TilingVertex>,
  delta: Record<string, { dx: number; dy: number }>,
  t: number,
): Record<string, TilingVertex> {
  const out: Record<string, TilingVertex> = {}
  for (const [id, v] of Object.entries(vertices)) {
    const d = delta[id]
    out[id] = d ? { ...v, x: v.x + t * d.dx, y: v.y + t * d.dy } : v
  }
  return out
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const OUT_OF_BOUNDS_EPS = 1e-9

function worstOutOfBoundsVertex(vertices: Record<string, TilingVertex>): { id: string; target: { x: number; y: number } } | null {
  let worst: { id: string; target: { x: number; y: number }; violation: number } | null = null
  for (const [id, v] of Object.entries(vertices)) {
    const target = { x: clamp01(v.x), y: clamp01(v.y) }
    const violation = Math.abs(v.x - target.x) + Math.abs(v.y - target.y)
    if (violation > OUT_OF_BOUNDS_EPS && (!worst || violation > worst.violation)) {
      worst = { id, target, violation }
    }
  }
  return worst
}

/** Pulls any out-of-bounds vertex back into `[0,1]^2` by repeatedly fitting
 * a bounded null-space step toward its clamped target (see
 * `computeMaxBoundedScale`'s doc for why this can never break a leg's
 * angle). A least-squares solve has no notion of the square's boundary, so
 * this is what keeps every *newly* mutating operation's result on-square --
 * called once, from `finalize`, after every commit. Gives up (accepting a
 * residual violation over ever moving off the null space) if a round makes
 * no progress -- rare, and only possible when the offending vertex has no
 * free direction left to correct it with. */
function pullVerticesIntoBounds(graph: TilingGraphState): TilingGraphState {
  let vertices = graph.vertices
  for (let iter = 0; iter < 8; iter++) {
    const offender = worstOutOfBoundsVertex(vertices)
    if (!offender) break
    const v = vertices[offender.id]
    const desired = { dx: offender.target.x - v.x, dy: offender.target.y - v.y }
    const coeffs = fitNullSpaceCoefficients(graph.nullSpaceBasis, offender.id, desired)
    const delta = fullDeltaFromCoefficients(Object.keys(vertices), graph.nullSpaceBasis, coeffs)
    const t = computeMaxBoundedScale(vertices, delta)
    if (t < 1e-9) break
    vertices = applyScaledDelta(vertices, delta, t)
  }
  return { ...graph, vertices }
}

function finalize(graph: TilingGraphState, tree: TreeState): TilingGraphState {
  const vertexIds = Object.keys(graph.vertices)
  const rows = [...allBaseRows(graph, tree), ...legRows(graph)]
  const withDerived = { ...graph, ...deriveFields(rows, vertexIds) }
  return pullVerticesIntoBounds(withDerived)
}

function projectAlongBorder(edge: EdgeSide, p: { x: number; y: number }): number {
  return edge === 'left' || edge === 'right' ? p.y : p.x
}

/** Picks, per border with at least one hull flap nearest it, the single
 * hull flap whose position along that border is closest to the border's
 * own midpoint -- the sole anchor for that border. Replaces "pin every
 * hull flap to its nearest edge" (which over-constrained adjacent
 * corner-ish flaps against each other) with a much lighter frame: up to 4
 * anchors, one per side actually touched by the hull. */
function pickBorderAnchors(hullFlapIds: string[], vertices: Record<string, TilingVertex>): Partial<Record<EdgeSide, string>> {
  const bestByEdge: Partial<Record<EdgeSide, { flapId: string; dist: number }>> = {}
  for (const flapId of hullFlapIds) {
    const v = vertices[flapId]
    if (!v) continue
    const edge = nearestEdge(v)
    const dist = Math.abs(projectAlongBorder(edge, v) - 0.5)
    const current = bestByEdge[edge]
    if (!current || dist < current.dist) bestByEdge[edge] = { flapId, dist }
  }
  const anchors: Partial<Record<EdgeSide, string>> = {}
  for (const [edge, best] of Object.entries(bestByEdge)) {
    if (best) anchors[edge as EdgeSide] = best.flapId
  }
  return anchors
}

/** Collapses any `intermediate` vertex left with exactly 2 legs whose
 * directions, read outward from that vertex, are opposite each other
 * (i.e. the "bend" is actually straight) into a single direct leg between
 * its two flap neighbors -- the vertex and both legs are removed. Compares
 * committed bin indices, not raw angles, since both legs' `angle` values
 * are already snapped -- exact float equality isn't needed or assumed.
 * Runs in a loop since collapsing one bend can't create another (a flap
 * vertex is never a merge candidate, only `intermediate` ones are), but a
 * single pass could still miss a later vertex in iteration order after an
 * earlier collapse changes `Object.values(legs)`; looping until a pass
 * finds nothing keeps this simple rather than reasoning about iteration
 * order. Mutates `vertices`/`legs` in place, matching this file's existing
 * seed-time construction style. */
export function mergeCollinearIndirectPaths(vertices: Record<string, TilingVertex>, legs: Record<string, TilingLeg>, bins: BinGeometry): void {
  let changed = true
  while (changed) {
    changed = false
    for (const v of Object.values(vertices)) {
      if (v.kind !== 'intermediate') continue
      const touching = Object.values(legs).filter((l) => l.vertexA === v.id || l.vertexB === v.id)
      if (touching.length !== 2) continue
      const [leg1, leg2] = touching
      const outward1 = legAngleAtVertex(leg1, v.id)
      const outward2 = legAngleAtVertex(leg2, v.id)
      if (binIndex(outward1, bins) !== binIndex(outward2 + Math.PI, bins)) continue

      const flapA = otherEndpoint(leg1, v.id)
      const flapB = otherEndpoint(leg2, v.id)
      const angle = legAngleAtVertex(leg1, flapA) // direction flapA -> v -> flapB, collinear so this equals flapA -> flapB
      delete legs[leg1.id]
      delete legs[leg2.id]
      delete vertices[v.id]
      const mergedId = nanoid()
      legs[mergedId] = { id: mergedId, kind: 'direct', vertexA: flapA, vertexB: flapB, angle }
      changed = true
      break
    }
  }
}

const NEAR_LINE_EPS = 2e-3

/** Where `p` falls relative to segment `a`-`c`: `t` is its parametric
 * position (0 at `a`, 1 at `c`; outside `[0,1]` means beyond an endpoint),
 * `perpDist` its perpendicular distance from the infinite line through
 * `a`/`c`. Degenerate (`a` == `c`) reports as infinitely far so callers
 * never treat it as "on" the segment. */
function pointToSegmentInfo(p: Point, a: Point, c: Point): { t: number; perpDist: number } {
  const dx = c.x - a.x
  const dy = c.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-12) return { t: -1, perpDist: Infinity }
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  const perpDist = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
  return { t, perpDist }
}

/** Finds every direct leg with one or more *other* vertices sitting on (or
 * within `NEAR_LINE_EPS` of) its segment, strictly between its two
 * endpoints -- common around the border, where the hull ring (see
 * `convexHullRing`) correctly excludes a flap collinear with two others as
 * not a true hull vertex, so the hull chain connects straight past it
 * (A-C) instead of stopping at it (A-B, B-C). Replaces each such leg with
 * a chain through every found vertex in order along the segment (handling
 * more than one), reusing the original leg's exact angle for every link
 * (still collinear by construction, so no re-derivation/re-snapping).
 * Mutates `vertices` positions untouched, only `legs`; no rank check --
 * splitting a leg through a vertex already sitting on it formalizes an
 * existing geometric fact rather than introducing a new one, so this is
 * expected to always be consistent (and `solveMinPerturbation` degrades
 * gracefully via least-squares even if a pathological input disagrees). */
export function splitDirectLegsThroughNearbyVertices(vertices: Record<string, TilingVertex>, legs: Record<string, TilingLeg>): void {
  for (const leg of Object.values(legs)) {
    if (leg.kind !== 'direct') continue
    const a = vertices[leg.vertexA]
    const c = vertices[leg.vertexB]
    if (!a || !c) continue
    const between = Object.values(vertices)
      .filter((v) => v.id !== leg.vertexA && v.id !== leg.vertexB)
      .map((v) => ({ id: v.id, ...pointToSegmentInfo(v, a, c) }))
      .filter((info) => info.t > 1e-6 && info.t < 1 - 1e-6 && info.perpDist < NEAR_LINE_EPS)
      .sort((x, y) => x.t - y.t)
    if (between.length === 0) continue

    const angle = legAngleAtVertex(leg, leg.vertexA) // direction A -> C, reused for every sub-leg (same forward direction)
    delete legs[leg.id]
    const chain = [leg.vertexA, ...between.map((b) => b.id), leg.vertexB]
    for (let i = 0; i < chain.length - 1; i++) {
      const id = nanoid()
      legs[id] = { id, kind: 'direct', vertexA: chain[i], vertexB: chain[i + 1], angle }
    }
  }
}

/** One-way seed: snapshots the current packing's flap positions and
 * constraints into a fresh, independent graph (see `TilingGraphState.
 * constraints`'s doc -- edits from here on never flow back to packing).
 *
 * Structure, built in three layers:
 * 1. Up to 4 border anchors (see `pickBorderAnchors`) pinned to their
 *    nearest edge, plus a chain of direct paths around the convex hull
 *    ring connecting every hull flap to its neighbor -- a light, rigid
 *    frame, replacing the old "pin every hull vertex" scheme.
 * 2. A best-effort call to the *dormant* automated MILP solver
 *    (`/api/tiling-snap`, via `fetchTilingSnap`) purely to suggest which
 *    *additional* interior paths to start with -- only its `selectedDirectPaths`/
 *    `vertices` (topology) are read, never its own solved positions or its
 *    own hull-pinning; every suggested angle is independently recomputed
 *    from *this* function's own current flap positions before being
 *    rank-checked in, so there's exactly one source of truth for "how an
 *    angle is derived." Any suggestion that doesn't fit (rejected by
 *    `tryAccept`, or whose endpoint slot is already used) is silently
 *    dropped -- seeding never fails or blocks on this being unavailable
 *    (unsupported shape, network error, no suggestions).
 * 3. A single minimum-perturbation solve of everything accepted above,
 *    then `finalize` (null-space + the boundary pull-in fix). */
export async function seedTilingGraph(
  tree: TreeState,
  constraints: ConstraintsState,
  hyperparams: HyperparamsState,
  packingPositions: Record<string, { x: number; y: number }>,
  scale: number,
): Promise<TilingGraphState> {
  const leafIds = getLeaves(tree)
  const vertices: Record<string, TilingVertex> = {}
  for (const leafId of leafIds) {
    const p = packingPositions[leafId]
    if (!p) continue
    vertices[leafId] = { id: leafId, kind: 'flap', flapId: leafId, x: p.x, y: p.y }
  }

  const graphConstraints: ConstraintsState = { ...constraints, perLeaf: { ...constraints.perLeaf } }
  const legs: Record<string, TilingLeg> = {}
  const frozenHullPins: FrozenHullPin[] = []
  let accepted = buildBaseRows(leafIds, graphConstraints)
  let columns = buildColumnIndex(Object.keys(vertices))

  const hullPoints = Object.values(vertices).map((v) => ({ id: v.id, x: v.x, y: v.y }))
  const hullRing = convexHullRing(hullPoints)

  // Layer 1a: one anchor per occupied border.
  const anchors = pickBorderAnchors(hullRing, vertices)
  for (const flapId of Object.values(anchors)) {
    if (!flapId) continue
    const constraint = graphConstraints.perLeaf[flapId]
    if (constraint && (constraint.boundary.kind !== 'none' || constraint.locked.kind === 'locked')) continue
    const row = nearestEdgeRow(flapId, vertices[flapId])
    if (tryAccept(accepted, [row], columns)) {
      accepted = [...accepted, row]
      frozenHullPins.push({ flapId, edge: nearestEdge(vertices[flapId]) })
    }
  }

  // Layer 1b: a chain of direct paths around the hull ring.
  const bins = binsFor(hyperparams, graphConstraints)
  if (bins) {
    for (let i = 0; i < hullRing.length; i++) {
      const a = hullRing[i]
      const b = hullRing[(i + 1) % hullRing.length]
      if (a === b || !vertices[a] || !vertices[b]) continue
      const theta = Math.atan2(vertices[b].y - vertices[a].y, vertices[b].x - vertices[a].x)
      const angle = snapNearestAngle(theta, bins)
      if (occupiedLegAt(legs, a, bins, angle) || occupiedLegAt(legs, b, bins, angle + Math.PI)) continue
      const row = legRow(a, b, angle)
      if (!tryAccept(accepted, [row], columns)) continue
      accepted = [...accepted, row]
      const legId = nanoid()
      legs[legId] = { id: legId, kind: 'direct', vertexA: a, vertexB: b, angle }
    }
  }

  // Layer 2: best-effort MILP-suggested interior paths.
  const treeIn = toTreeIn(tree)
  if (treeIn && bins) {
    try {
      const positionsOut = leafIds.filter((id) => vertices[id]).map((id) => ({ nodeId: id, x: vertices[id].x, y: vertices[id].y }))
      const response = await fetchTilingSnap(treeIn, constraints, hyperparams, positionsOut, scale)
      if (response.status === 'ok' && response.leafPositions.length > 0) {
        for (const { a, b } of response.selectedDirectPaths) {
          if (!vertices[a] || !vertices[b]) continue
          const theta = Math.atan2(vertices[b].y - vertices[a].y, vertices[b].x - vertices[a].x)
          const angle = snapNearestAngle(theta, bins)
          if (occupiedLegAt(legs, a, bins, angle) || occupiedLegAt(legs, b, bins, angle + Math.PI)) continue
          const row = legRow(a, b, angle)
          if (!tryAccept(accepted, [row], columns)) continue
          accepted = [...accepted, row]
          const legId = nanoid()
          legs[legId] = { id: legId, kind: 'direct', vertexA: a, vertexB: b, angle }
        }

        for (const suggestedVertex of response.vertices) {
          const attachedFlaps = suggestedVertex.legs.map((l) => l.flap).filter((f) => vertices[f])
          if (attachedFlaps.length < 2) continue
          const bendVertexId = nanoid()
          const avgX = attachedFlaps.reduce((s, f) => s + vertices[f].x, 0) / attachedFlaps.length
          const avgY = attachedFlaps.reduce((s, f) => s + vertices[f].y, 0) / attachedFlaps.length
          const workingColumns = buildColumnIndex([...Object.keys(vertices), bendVertexId])
          const stagedRows: Row[] = []
          const stagedLegs: TilingLeg[] = []
          for (const flap of attachedFlaps) {
            const theta = Math.atan2(avgY - vertices[flap].y, avgX - vertices[flap].x)
            const angle = snapNearestAngle(theta, bins)
            if (occupiedLegAt(legs, flap, bins, angle)) continue
            const row = legRow(flap, bendVertexId, angle)
            if (!tryAccept([...accepted, ...stagedRows], [row], workingColumns)) continue
            stagedRows.push(row)
            stagedLegs.push({ id: nanoid(), kind: 'indirect', vertexA: flap, vertexB: bendVertexId, angle })
          }
          if (stagedLegs.length >= 2) {
            vertices[bendVertexId] = { id: bendVertexId, kind: 'intermediate', x: avgX, y: avgY }
            accepted = [...accepted, ...stagedRows]
            for (const leg of stagedLegs) legs[leg.id] = leg
            columns = buildColumnIndex(Object.keys(vertices))
          }
        }
      }
    } catch {
      // Best-effort suggestion only -- the hull anchors + chain above are
      // already a complete, valid seed on their own.
    }
  }

  // Layer 3: post-process degeneracies that layers 1-2 routinely produce
  // (see each function's own doc) -- run the merge before the split since
  // a merged direct leg can itself need splitting, but not vice versa.
  if (bins) {
    mergeCollinearIndirectPaths(vertices, legs, bins)
    splitDirectLegsThroughNearbyVertices(vertices, legs)
  }

  const stagingGraph: TilingGraphState = {
    vertices,
    legs,
    frozenHullPins,
    constraints: graphConstraints,
    dof: 0,
    freeAxes: {},
    nullSpaceBasis: [],
  }
  const vertexIds = Object.keys(vertices)
  const finalColumns = buildColumnIndex(vertexIds)
  const finalRows = [...allBaseRows(stagingGraph, tree), ...legRows(stagingGraph)]
  const x0 = flattenPositions(vertexIds, finalColumns, vertices)
  const solved = solveMinPerturbation(finalRows, finalColumns, x0)
  const solvedVertices = applyPositions(vertices, unflattenPositions(vertexIds, finalColumns, solved))
  return finalize({ ...stagingGraph, vertices: solvedVertices }, tree)
}

/** Pure preview geometry for a not-yet-committed path between two vertices
 * -- no rank check, no mutation. `commitPathOption` recomputes the same
 * geometry itself rather than trusting a stale preview object, so the two
 * can never disagree. */
export function previewPathCandidates(
  graph: TilingGraphState,
  hyperparams: HyperparamsState,
  vertexAId: string,
  vertexBId: string,
): { candidates: TilingPathCandidates } | { error: string } {
  const bins = binsFor(hyperparams, graph.constraints)
  if (!bins) return { error: 'This shape has no discrete crease directions.' }
  const pa = graph.vertices[vertexAId]
  const pb = graph.vertices[vertexBId]
  if (!pa || !pb || vertexAId === vertexBId) return { error: 'Pick two distinct vertices.' }
  const options = computePathOptions(pa, pb, bins)
  if (options.length === 0) return { error: 'No path is offered between these two vertices.' }
  return { candidates: { vertexAId, vertexBId, options } }
}

export function addDirectLeg(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
  vertexAId: string,
  vertexBId: string,
): Result<TilingGraphState> {
  const bins = binsFor(hyperparams, graph.constraints)
  if (!bins) return { error: 'This shape has no discrete crease directions.' }
  const pa = graph.vertices[vertexAId]
  const pb = graph.vertices[vertexBId]
  if (!pa || !pb || vertexAId === vertexBId) return { error: 'Pick two distinct vertices.' }

  const theta = Math.atan2(pb.y - pa.y, pb.x - pa.x)
  const angle = snapNearestAngle(theta, bins)

  if (occupiedLegAt(graph.legs, vertexAId, bins, angle) || occupiedLegAt(graph.legs, vertexBId, bins, angle + Math.PI)) {
    return { error: 'That direction is already in use at one of these vertices.' }
  }

  const vertexIds = Object.keys(graph.vertices)
  const columns = buildColumnIndex(vertexIds)
  const existingRows = [...allBaseRows(graph, tree), ...legRows(graph)]
  const newRow = legRow(vertexAId, vertexBId, angle)
  if (!tryAccept(existingRows, [newRow], columns)) {
    return { error: 'This path would overconstrain the tiling.' }
  }

  const x0 = flattenPositions(vertexIds, columns, graph.vertices)
  const solved = solveMinPerturbation([...existingRows, newRow], columns, x0)
  const newPositions = unflattenPositions(vertexIds, columns, solved)

  const newLeg: TilingLeg = { id: nanoid(), kind: 'direct', vertexA: vertexAId, vertexB: vertexBId, angle }
  if (segmentCrossesAny(Object.values(graph.legs), [newLeg], newPositions)) {
    return { error: 'This path crosses an existing path.' }
  }

  const vertices = applyPositions(graph.vertices, newPositions)
  const legs = { ...graph.legs, [newLeg.id]: newLeg }
  return { graph: finalize({ ...graph, vertices, legs }, tree) }
}

export function commitBentPath(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
  vertexAId: string,
  vertexBId: string,
  configIndex: 0 | 1,
): Result<TilingGraphState> {
  const bins = binsFor(hyperparams, graph.constraints)
  if (!bins) return { error: 'This shape has no discrete crease directions.' }
  const pa = graph.vertices[vertexAId]
  const pb = graph.vertices[vertexBId]
  if (!pa || !pb || vertexAId === vertexBId) return { error: 'Pick two distinct vertices.' }

  const theta = Math.atan2(pb.y - pa.y, pb.x - pa.x)
  const [thetaLo, thetaHi] = bracketAngles(theta, bins)
  const decomposed = decomposeBend(pa, pb, thetaLo, thetaHi)
  if (!decomposed) {
    return { error: 'These two vertices already line up with a single crease direction -- use a direct path instead.' }
  }
  const config = decomposed[configIndex]

  const occupiedA = occupiedLegAt(graph.legs, vertexAId, bins, config.legAngleFromA)
  const occupiedB = occupiedLegAt(graph.legs, vertexBId, bins, config.legAngleFromB)
  if (occupiedA?.kind === 'direct' || occupiedB?.kind === 'direct') {
    return { error: 'This path overlaps an existing direct path.' }
  }
  const mergeTargetA = occupiedA ? otherEndpoint(occupiedA, vertexAId) : null
  const mergeTargetB = occupiedB ? otherEndpoint(occupiedB, vertexBId) : null
  if (mergeTargetA && mergeTargetB) {
    if (mergeTargetA === mergeTargetB) return { error: 'This path already exists.' }
    return { error: "Can't merge two different junctions in one step." }
  }

  let workingVertices = graph.vertices
  let newLegs: TilingLeg[]
  if (mergeTargetA) {
    newLegs = [{ id: nanoid(), kind: 'indirect', vertexA: vertexBId, vertexB: mergeTargetA, angle: config.legAngleFromB }]
  } else if (mergeTargetB) {
    newLegs = [{ id: nanoid(), kind: 'indirect', vertexA: vertexAId, vertexB: mergeTargetB, angle: config.legAngleFromA }]
  } else {
    const bendVertexId = nanoid()
    workingVertices = {
      ...workingVertices,
      [bendVertexId]: { id: bendVertexId, kind: 'intermediate', x: config.bendPoint.x, y: config.bendPoint.y },
    }
    newLegs = [
      { id: nanoid(), kind: 'indirect', vertexA: vertexAId, vertexB: bendVertexId, angle: config.legAngleFromA },
      { id: nanoid(), kind: 'indirect', vertexA: vertexBId, vertexB: bendVertexId, angle: config.legAngleFromB },
    ]
  }

  const vertexIds = Object.keys(workingVertices)
  const columns = buildColumnIndex(vertexIds)
  const workingGraph: TilingGraphState = { ...graph, vertices: workingVertices }
  const existingRows = [...allBaseRows(workingGraph, tree), ...legRows(workingGraph)]
  const newRows = newLegs.map((leg) => legRow(leg.vertexA, leg.vertexB, leg.angle))
  if (!tryAccept(existingRows, newRows, columns)) {
    return { error: 'This path would overconstrain the tiling.' }
  }

  const x0 = flattenPositions(vertexIds, columns, workingVertices)
  const solved = solveMinPerturbation([...existingRows, ...newRows], columns, x0)
  const newPositions = unflattenPositions(vertexIds, columns, solved)

  if (segmentCrossesAny(Object.values(graph.legs), newLegs, newPositions)) {
    return { error: 'This path crosses an existing path.' }
  }

  const vertices = applyPositions(workingVertices, newPositions)
  const legs = { ...graph.legs }
  for (const leg of newLegs) legs[leg.id] = leg
  return { graph: finalize({ ...graph, vertices, legs }, tree) }
}

/** Commits whichever candidate the user picked from `previewPathCandidates`'s
 * offered list -- dispatches to `addDirectLeg` or `commitBentPath`
 * depending on `option.kind`; both recompute their own geometry fresh
 * rather than trusting the option's cached angle/config, so this can never
 * disagree with what was actually previewed. */
export function commitPathOption(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
  vertexAId: string,
  vertexBId: string,
  option: PathOption,
): Result<TilingGraphState> {
  if (option.kind === 'direct') return addDirectLeg(graph, tree, hyperparams, vertexAId, vertexBId)
  return commitBentPath(graph, tree, hyperparams, vertexAId, vertexBId, option.configIndex)
}

/** Deleting a direct leg just drops its row. Deleting an indirect leg can
 * cascade: an `intermediate` vertex only ever has degree 0 or >=2, so if a
 * removal drops one down to degree 1, its one remaining leg (and then the
 * vertex itself) is removed too -- this single rule is exactly "a 2-legged
 * path loses a leg -> drop both the other leg and the vertex", and
 * correctly leaves a 3+-leg junction alone when it only drops to 2. */
export function deleteTilingLeg(graph: TilingGraphState, tree: TreeState, legId: string): TilingGraphState {
  const legs = { ...graph.legs }
  const vertices = { ...graph.vertices }
  const removed = new Set<string>()
  const queue = [legId]

  while (queue.length > 0) {
    const currentId = queue.shift() as string
    if (removed.has(currentId)) continue
    const leg = legs[currentId]
    if (!leg) continue
    delete legs[currentId]
    removed.add(currentId)

    for (const vId of [leg.vertexA, leg.vertexB]) {
      const v = vertices[vId]
      if (!v || v.kind !== 'intermediate') continue
      const remaining = Object.values(legs).filter((l) => l.vertexA === vId || l.vertexB === vId)
      if (remaining.length === 0) delete vertices[vId]
      else if (remaining.length === 1) queue.push(remaining[0].id)
    }
  }

  const vertexIds = Object.keys(vertices)
  const columns = buildColumnIndex(vertexIds)
  const nextGraph: TilingGraphState = { ...graph, vertices, legs }
  const rows = [...allBaseRows(nextGraph, tree), ...legRows(nextGraph)]
  const x0 = flattenPositions(vertexIds, columns, vertices)
  const solved = solveMinPerturbation(rows, columns, x0)
  const finalVertices = applyPositions(vertices, unflattenPositions(vertexIds, columns, solved))
  return finalize({ ...nextGraph, vertices: finalVertices }, tree)
}

/** Deletes every leg touching `vertexId` (one at a time, via
 * `deleteTilingLeg`'s existing cascade) -- for a flap vertex this just
 * un-tiles it (the vertex itself always remains, 1:1 with its tree leaf);
 * for an intermediate vertex it naturally disappears once its own last leg
 * goes. Mirrors the packing Inspector's delete button, generalized to not
 * need a kind-specific case split. */
export function deleteTilingVertexAndLegs(graph: TilingGraphState, tree: TreeState, vertexId: string): TilingGraphState {
  let current = graph
  const touching = () => Object.values(current.legs).filter((l) => l.vertexA === vertexId || l.vertexB === vertexId)
  let legsTouching = touching()
  while (legsTouching.length > 0) {
    current = deleteTilingLeg(current, tree, legsTouching[0].id)
    legsTouching = touching()
  }
  return current
}

/** Rebuilds the graph's rows from a new `constraints` value and re-solves
 * unconditionally -- no rank-check gate, matching `build_base_rows`'s own
 * precedent (base/user-declared constraints are always added
 * unconditionally, trusting the caller not to offer an infeasible
 * combination; `solveMinPerturbation`'s least-squares degrades gracefully
 * even if a combination turns out inconsistent). */
function applyConstraintChange(graph: TilingGraphState, tree: TreeState, nextConstraints: ConstraintsState): TilingGraphState {
  const nextGraph: TilingGraphState = { ...graph, constraints: nextConstraints }
  const vertexIds = Object.keys(nextGraph.vertices)
  const columns = buildColumnIndex(vertexIds)
  const rows = [...allBaseRows(nextGraph, tree), ...legRows(nextGraph)]
  const x0 = flattenPositions(vertexIds, columns, nextGraph.vertices)
  const solved = solveMinPerturbation(rows, columns, x0)
  const vertices = applyPositions(nextGraph.vertices, unflattenPositions(vertexIds, columns, solved))
  return finalize({ ...nextGraph, vertices }, tree)
}

function tilingLeafConstraint(graph: TilingGraphState, flapId: string): LeafConstraint {
  return graph.constraints.perLeaf[flapId] ?? NO_LEAF_CONSTRAINT
}

export function pinTilingVertexToSymmetry(graph: TilingGraphState, tree: TreeState, flapId: string): Result<TilingGraphState> {
  const mode = graph.constraints.symmetryMode
  if (mode === 'none') return { error: 'Turn on symmetry mode in the packing editor first.' }
  const candidate: LeafConstraint = { ...tilingLeafConstraint(graph, flapId), symmetry: { kind: 'pin_symmetry' } }
  const res = resolveLeafConstraint(mode, candidate)
  if (!res.feasible) return { error: "This vertex's edge/corner pin can't be combined with symmetry in this mode." }
  const nextConstraints = withPinSymmetry(graph.constraints, flapId)
  if (res.point && findPointCollision(collectResolvedPoints(tree, nextConstraints), res.point, flapId)) {
    return { error: 'That position is already occupied by another vertex.' }
  }
  return { graph: applyConstraintChange(graph, tree, nextConstraints) }
}

export function pinTilingVertexToEdge(graph: TilingGraphState, tree: TreeState, flapId: string, edge: EdgeSide): Result<TilingGraphState> {
  const candidate: LeafConstraint = { ...tilingLeafConstraint(graph, flapId), boundary: { kind: 'pin_edge', edge } }
  const res = resolveLeafConstraint(graph.constraints.symmetryMode, candidate)
  if (!res.feasible) return { error: "That edge can't be combined with this vertex's symmetry pin." }
  const nextConstraints = withPinEdge(graph.constraints, flapId, edge)
  if (findAnyCollision(collectResolvedPoints(tree, nextConstraints))) {
    return { error: 'That position is already occupied by another vertex.' }
  }
  return { graph: applyConstraintChange(graph, tree, nextConstraints) }
}

export function pinTilingVertexToCorner(
  graph: TilingGraphState,
  tree: TreeState,
  flapId: string,
  corner: CornerId,
): Result<TilingGraphState> {
  const candidate: LeafConstraint = { ...tilingLeafConstraint(graph, flapId), boundary: { kind: 'pin_corner', corner } }
  const res = resolveLeafConstraint(graph.constraints.symmetryMode, candidate)
  if (!res.feasible) return { error: "That corner can't be combined with this vertex's symmetry pin." }
  const nextConstraints = withPinCorner(graph.constraints, flapId, corner)
  if (findAnyCollision(collectResolvedPoints(tree, nextConstraints))) {
    return { error: 'That corner is already occupied by another vertex.' }
  }
  return { graph: applyConstraintChange(graph, tree, nextConstraints) }
}

export function clearTilingVertexSymmetry(graph: TilingGraphState, tree: TreeState, flapId: string): TilingGraphState {
  return applyConstraintChange(graph, tree, withClearedSymmetry(graph.constraints, flapId))
}

export function clearTilingVertexBoundary(graph: TilingGraphState, tree: TreeState, flapId: string): TilingGraphState {
  return applyConstraintChange(graph, tree, withClearedBoundary(graph.constraints, flapId))
}

export function toggleTilingVertexLock(graph: TilingGraphState, tree: TreeState, flapId: string): TilingGraphState {
  const current = tilingLeafConstraint(graph, flapId)
  if (current.locked.kind === 'locked') {
    return applyConstraintChange(graph, tree, withClearedLock(graph.constraints, flapId))
  }
  // Same guard as the packing Inspector's toggleLock: nothing new to freeze
  // if symmetry+boundary already fully fix it, and a pair's follower's
  // position is always derived from its leader regardless of its own lock.
  if (isFullyFixedBySymmetryBoundary(graph.constraints.symmetryMode, current)) return graph
  if (current.symmetry.kind === 'pair' && flapId > current.symmetry.pairedWith) return graph
  const vertex = graph.vertices[flapId]
  if (!vertex) return graph
  return applyConstraintChange(graph, tree, withLocked(graph.constraints, flapId, { x: vertex.x, y: vertex.y }))
}

/** Applies a drag of `vertexId` toward `desiredPosition` as a linear
 * combination of the graph's current null-space basis vectors, scaled down
 * (never clamped per-vertex -- see `computeMaxBoundedScale`'s doc) so
 * every vertex stays inside `[0,1]^2`. Any such combination preserves
 * `A x = b` exactly by construction, so this needs no rank check, no
 * re-solve, and no backend round trip -- entirely synchronous. A vertex
 * with no free axes naturally fits a near-zero combination (nothing to
 * drag). */
export function projectVertexDrag(
  graph: TilingGraphState,
  vertexId: string,
  desiredPosition: { x: number; y: number },
): Record<string, { x: number; y: number }> {
  const current = graph.vertices[vertexId]
  if (!current) return {}
  const target = { x: clamp01(desiredPosition.x), y: clamp01(desiredPosition.y) }
  const desired = { dx: target.x - current.x, dy: target.y - current.y }
  const coeffs = fitNullSpaceCoefficients(graph.nullSpaceBasis, vertexId, desired)
  const vertexIds = Object.keys(graph.vertices)
  const delta = fullDeltaFromCoefficients(vertexIds, graph.nullSpaceBasis, coeffs)
  const t = computeMaxBoundedScale(graph.vertices, delta)

  const out: Record<string, { x: number; y: number }> = {}
  for (const id of vertexIds) {
    const v = graph.vertices[id]
    const d = delta[id] ?? { dx: 0, dy: 0 }
    out[id] = { x: v.x + t * d.dx, y: v.y + t * d.dy }
  }
  return out
}
