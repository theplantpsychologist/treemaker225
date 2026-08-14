import { nanoid } from 'nanoid'
import { fetchTilingSnap } from '../../api/client'
import type { ConstraintsState, CornerId, EdgeSide, LeafConstraint } from '../../types/constraints'
import { NO_LEAF_CONSTRAINT } from '../../types/constraints'
import type { HyperparamsState } from '../../types/hyperparams'
import type { TreeState } from '../../types/tree'
import { toTreeIn } from '../../types/tree'
import type { HingeChainLock, SkeletonLock, TilingGraphState, TilingLeg, TilingPathCandidates, TilingVertex } from '../../types/tilingGraph'
import type { PathOption } from '../../geometry/tilingGraphOps'
import type { Point } from '../../geometry/symmetry'
import { cotangentRow, signatureOf, slidingQuadruplets } from '../../geometry/tilingCotangent'
import { computeFaces, legIdByFaceEdge } from '../../geometry/planarFaces'
import { computeStraightSkeleton } from '../../geometry/straightSkeleton'
import { computeHingeChains, type HingeChain, type ResolvedSkeletonFace } from '../../geometry/hingeChains'
import { prepareMirrors, type MirrorSegment } from '../../geometry/hingeRayCast'
import { buildHingeChainConstraint, findCommonLeg, type HingeChainRef } from '../../geometry/hingeChainLock'
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

function allBaseRows(graph: TilingGraphState, tree: TreeState): Row[] {
  return buildBaseRows(getLeaves(tree), graph.constraints)
}

function legRows(graph: TilingGraphState): Row[] {
  return Object.values(graph.legs).map((leg) => legRow(leg.vertexA, leg.vertexB, leg.angle))
}

/** Rows for every active `SkeletonLock` -- a lock referencing a since-deleted
 * leg contributes nothing (inert until `deleteTilingLeg` prunes it, or the
 * live-geometry check in `TilingEditorCanvas.tsx` releases it). Each lock's
 * `legIds` expand to `n - 3` overlapping quadruplet rows (see
 * `slidingQuadruplets`), read fresh from `graph.legs` every time so a lock
 * never carries its own stale copy of an angle/vertex. */
function lockRows(graph: TilingGraphState): Row[] {
  const rows: Row[] = []
  for (const lock of graph.skeletonLocks) {
    if (!lock.legIds.every((id) => graph.legs[id])) continue
    const pairs = lock.legIds.map((legId, i) => ({ legId, entryVertexId: lock.entryVertexIds[i] }))
    for (const quad of slidingQuadruplets(pairs)) {
      const row = cotangentRow(
        quad.map(({ legId, entryVertexId }) => {
          const leg = graph.legs[legId]
          return { vertexId: entryVertexId, angle: legAngleAtVertex(leg, entryVertexId) }
        }),
      )
      if (row) rows.push(row)
    }
  }
  return rows
}

/** A `HingeChainSideLock`'s stored `crossings` omit `point` (never read by
 * `buildHingeChainConstraint`/`findCommonLeg`, so never persisted) -- fill
 * in a placeholder to satisfy `HingeChainRef`'s (i.e. `HingeChain`'s) own
 * `HingeCrossing` shape. */
function hingeChainRef(side: HingeChainLock['a']): HingeChainRef {
  return { ...side, crossings: side.crossings.map((c) => ({ ...c, point: { x: 0, y: 0 } })) }
}

/** Rows for every active `HingeChainLock` -- re-derives
 * `buildHingeChainConstraint` fresh from *current* `graph.legs` each time
 * (angles never drift, so this is cheap), silently contributing nothing for
 * a lock referencing a since-deleted leg or otherwise degenerate configuration
 * (inert until `deleteTilingLeg`'s cascade or `pruneStaleTilingHingeChainLocks`
 * releases it) -- same convention as `lockRows`. */
function hingeChainLockRows(graph: TilingGraphState): Row[] {
  const rows: Row[] = []
  for (const lock of graph.hingeChainLocks) {
    const result = buildHingeChainConstraint(hingeChainRef(lock.a), hingeChainRef(lock.b), lock.commonLegId, graph)
    if ('row' in result) rows.push(result.row)
  }
  return rows
}

/** The full active row set for a solve/rank-check: user constraints, hull
 * pins, every leg's direction, every locked incircle vertex's cotangent
 * rows, and every hinge-chain collinearity lock's row. Every graph-mutating
 * operation below must assemble its own solve from this (not just
 * `finalize`), since each one solves positions itself before `finalize`
 * ever runs -- patching only `finalize` would let positions silently drift
 * off a lock between edits. */
function activeRows(graph: TilingGraphState, tree: TreeState): Row[] {
  return [...allBaseRows(graph, tree), ...legRows(graph), ...lockRows(graph), ...hingeChainLockRows(graph)]
}

/** The unit square's own 4 physical edges, in the same coordinates as
 * every tiling vertex -- mirrors `TilingEditorCanvas.tsx`'s own copy (a
 * hinge ray reaching one of these has run off the paper and stops there,
 * see `hingeRayCast.ts`'s `castHingeRay`). Duplicated rather than shared
 * since it's 4 fixed segments that never change; not worth a new module. */
const UNIT_SQUARE_BOUNDARY = prepareMirrors([
  { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
  { a: { x: 1, y: 0 }, b: { x: 1, y: 1 } },
  { a: { x: 1, y: 1 }, b: { x: 0, y: 1 } },
  { a: { x: 0, y: 1 }, b: { x: 0, y: 0 } },
])

/** Self-contained recompute of every live `HingeChain` for `graph` --
 * mirrors `TilingEditorCanvas.tsx`'s own `skeletons`/`skeletonNodesWithLegIds`/
 * `hingeChains` pipeline, but from scratch each call rather than reusing the
 * canvas's per-render memo, since callers here (`setHingeChainLock`'s
 * re-verify, `pruneStaleTilingHingeChainLocks`) run at most once per
 * discrete user gesture (a click, or a mouseup), not once per render/drag
 * frame -- see `state/store.ts`'s `runTilingCleanup`-adjacent wiring for
 * where the mouseup gating actually happens. */
function computeLiveHingeChains(graph: TilingGraphState, hyperparams: HyperparamsState, dedupe = true): HingeChain[] {
  const legsList = Object.values(graph.legs)
  const legMirrors: MirrorSegment[] = []
  const legIdByMirrorIndex: string[] = []
  for (const leg of legsList) {
    const a = graph.vertices[leg.vertexA]
    const b = graph.vertices[leg.vertexB]
    if (a && b) {
      legMirrors.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } })
      legIdByMirrorIndex.push(leg.id)
    }
  }

  const ridgeMirrors: MirrorSegment[] = []
  const resolvedFaces: ResolvedSkeletonFace[] = []
  for (const face of computeFaces(graph.vertices, legsList)) {
    const polygon = face.vertexIds.map((id) => graph.vertices[id])
    const skeleton = computeStraightSkeleton(polygon)
    if (!skeleton) continue
    const faceLegIds = legIdByFaceEdge(face, legsList)
    const nodes = skeleton.nodes
      .map((node) => ({ node, legIds: node.tangentEdges.map((i) => faceLegIds[i]) }))
      .filter((n): n is { node: (typeof skeleton.nodes)[number]; legIds: string[] } => n.legIds.every((id) => id != null))
    resolvedFaces.push({ faceId: face.id, skeleton, nodes })
    ridgeMirrors.push(...skeleton.ridges.map((r) => ({ a: r.start, b: r.end })))
  }

  const tilingVertices = Object.values(graph.vertices).map((v) => ({ id: v.id, x: v.x, y: v.y }))
  return computeHingeChains(
    resolvedFaces,
    prepareMirrors(legMirrors),
    legIdByMirrorIndex,
    prepareMirrors(ridgeMirrors),
    UNIT_SQUARE_BOUNDARY,
    tilingVertices,
    hyperparams.tilingMinFeatureSize,
    hyperparams.tilingMaxHingeBounces,
    dedupe,
  )
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

/** Hexagon mode's indirect (bend) vertices are allowed to sit outside the
 * physical unit square (see `commitBentPath`'s doc) -- every mechanism that
 * otherwise keeps a vertex inside `[0,1]^2` (drag clamping, the post-solve
 * pull-in) skips a vertex this returns true for. A flap is never exempt: its
 * position always corresponds to a real point on the packed paper. */
function boundsExempt(vertex: TilingVertex, hyperparams: HyperparamsState): boolean {
  return vertex.kind === 'intermediate' && hyperparams.shape === 'hexagon'
}

/** The largest `t in [0,1]` such that applying `t * delta` to every
 * non-exempt vertex (see `boundsExempt`) keeps it inside `[0,1]^2`. Scaling a
 * null-space vector by any scalar keeps it in the null space (`A(t*v) =
 * t*(Av) = 0`), so this is the *only* way to respect the square's boundary
 * without ever perturbing a leg's committed angle -- clamping coordinates
 * independently (the old, wrong approach) changes each vertex by a different
 * amount and silently breaks the shared-leg angle invariant between them. */
function computeMaxBoundedScale(
  vertices: Record<string, TilingVertex>,
  delta: Record<string, { dx: number; dy: number }>,
  hyperparams: HyperparamsState,
): number {
  let t = 1
  for (const [id, d] of Object.entries(delta)) {
    const v = vertices[id]
    if (!v || boundsExempt(v, hyperparams)) continue
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

function worstOutOfBoundsVertex(
  vertices: Record<string, TilingVertex>,
  hyperparams: HyperparamsState,
): { id: string; target: { x: number; y: number } } | null {
  let worst: { id: string; target: { x: number; y: number }; violation: number } | null = null
  for (const [id, v] of Object.entries(vertices)) {
    if (boundsExempt(v, hyperparams)) continue
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
function pullVerticesIntoBounds(graph: TilingGraphState, hyperparams: HyperparamsState): TilingGraphState {
  let vertices = graph.vertices
  for (let iter = 0; iter < 8; iter++) {
    const offender = worstOutOfBoundsVertex(vertices, hyperparams)
    if (!offender) break
    const v = vertices[offender.id]
    const desired = { dx: offender.target.x - v.x, dy: offender.target.y - v.y }
    const coeffs = fitNullSpaceCoefficients(graph.nullSpaceBasis, offender.id, desired)
    const delta = fullDeltaFromCoefficients(Object.keys(vertices), graph.nullSpaceBasis, coeffs)
    const t = computeMaxBoundedScale(vertices, delta, hyperparams)
    if (t < 1e-9) break
    vertices = applyScaledDelta(vertices, delta, t)
  }
  return { ...graph, vertices }
}

function finalize(graph: TilingGraphState, tree: TreeState, hyperparams: HyperparamsState): TilingGraphState {
  const vertexIds = Object.keys(graph.vertices)
  const rows = activeRows(graph, tree)
  const withDerived = { ...graph, ...deriveFields(rows, vertexIds) }
  return pullVerticesIntoBounds(withDerived, hyperparams)
}

// `projectAlongBorder`/`pickBorderAnchors` backed the automatic boundary
// pinning disabled above (see that comment) -- kept here, unused, as a
// reference in case it's reinstated as an opt-in action later.
//
// function projectAlongBorder(edge: EdgeSide, p: { x: number; y: number }): number {
//   return edge === 'left' || edge === 'right' ? p.y : p.x
// }
//
// /** Picks, per border with at least one hull flap nearest it, the single
//  * hull flap whose position along that border is closest to the border's
//  * own midpoint -- the sole anchor for that border. Replaces "pin every
//  * hull flap to its nearest edge" (which over-constrained adjacent
//  * corner-ish flaps against each other) with a much lighter frame: up to 4
//  * anchors, one per side actually touched by the hull. */
// function pickBorderAnchors(hullFlapIds: string[], vertices: Record<string, TilingVertex>): Partial<Record<EdgeSide, string>> {
//   const bestByEdge: Partial<Record<EdgeSide, { flapId: string; dist: number }>> = {}
//   for (const flapId of hullFlapIds) {
//     const v = vertices[flapId]
//     if (!v) continue
//     const edge = nearestEdge(v)
//     const dist = Math.abs(projectAlongBorder(edge, v) - 0.5)
//     const current = bestByEdge[edge]
//     if (!current || dist < current.dist) bestByEdge[edge] = { flapId, dist }
//   }
//   const anchors: Partial<Record<EdgeSide, string>> = {}
//   for (const [edge, best] of Object.entries(bestByEdge)) {
//     if (best) anchors[edge as EdgeSide] = best.flapId
//   }
//   return anchors
// }

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
 * within `eps` of) its segment, strictly between its two endpoints --
 * common around the border, where the hull ring (see `convexHullRing`)
 * correctly excludes a flap collinear with two others as not a true hull
 * vertex, so the hull chain connects straight past it (A-C) instead of
 * stopping at it (A-B, B-C). Replaces each such leg with a chain through
 * every found vertex in order along the segment (handling more than one),
 * reusing the original leg's exact angle for every link (still collinear
 * by construction, so no re-derivation/re-snapping). Mutates `vertices`
 * positions untouched, only `legs`; no rank check -- splitting a leg
 * through a vertex already sitting on it formalizes an existing geometric
 * fact rather than introducing a new one, so this is expected to always be
 * consistent (and `solveMinPerturbation` degrades gracefully via
 * least-squares even if a pathological input disagrees). */
export function splitDirectLegsThroughNearbyVertices(
  vertices: Record<string, TilingVertex>,
  legs: Record<string, TilingLeg>,
  eps: number,
): void {
  for (const leg of Object.values(legs)) {
    if (leg.kind !== 'direct') continue
    const a = vertices[leg.vertexA]
    const c = vertices[leg.vertexB]
    if (!a || !c) continue
    const between = Object.values(vertices)
      .filter((v) => v.id !== leg.vertexA && v.id !== leg.vertexB)
      .map((v) => ({ id: v.id, ...pointToSegmentInfo(v, a, c) }))
      .filter((info) => info.t > 1e-6 && info.t < 1 - 1e-6 && info.perpDist < eps)
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
 * Structure, built in three layers (`mode === 'manual'` skips layers 1b and
 * 2 entirely, seeding bare flap vertices with no legs and no new
 * constraints for the user to connect by hand):
 * 1. (Automatic boundary pinning, formerly here, is disabled -- see the
 *    comment where it used to run, just inside this function.) A chain of
 *    direct paths around the convex hull ring connecting every hull flap to
 *    its neighbor -- a light, rigid frame, replacing the old "pin every hull
 *    vertex" scheme.
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
  mode: 'suggested' | 'manual' = 'suggested',
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
  let accepted = buildBaseRows(leafIds, graphConstraints)
  let columns = buildColumnIndex(Object.keys(vertices))

  const hullPoints = Object.values(vertices).map((v) => ({ id: v.id, x: v.x, y: v.y }))
  const hullRing = convexHullRing(hullPoints)

  // Layer 1a (automatic boundary pinning) is disabled -- it sometimes
  // over-constrained the seed in ways that were hard to spot and harder to
  // undo (the user would need to notice a flap was pinned before they could
  // clear it); pinning an edge/corner is easy to add afterward from the
  // Inspector, so it's no longer done automatically here. Kept commented
  // out (rather than deleted) as a reference for `pickBorderAnchors`'s own
  // reasoning, still defined just below.
  //
  // const anchors = pickBorderAnchors(hullRing, vertices)
  // for (const flapId of Object.values(anchors)) {
  //   if (!flapId) continue
  //   const constraint = graphConstraints.perLeaf[flapId]
  //   if (constraint && (constraint.boundary.kind !== 'none' || constraint.locked.kind === 'locked')) continue
  //   const row = nearestEdgeRow(flapId, vertices[flapId])
  //   if (tryAccept(accepted, [row], columns)) {
  //     accepted = [...accepted, row]
  //     const edge = nearestEdge(vertices[flapId])
  //     graphConstraints.perLeaf[flapId] = { ...(constraint ?? NO_LEAF_CONSTRAINT), boundary: { kind: 'pin_edge', edge } }
  //   }
  // }

  // Layer 1b: a chain of direct paths around the hull ring.
  const bins = binsFor(hyperparams, graphConstraints)
  if (bins && mode === 'suggested') {
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
  if (treeIn && bins && mode === 'suggested') {
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
    splitDirectLegsThroughNearbyVertices(vertices, legs, hyperparams.tilingMinFeatureSize)
  }

  const stagingGraph: TilingGraphState = {
    vertices,
    legs,
    constraints: graphConstraints,
    skeletonLocks: [],
    hingeChainLocks: [],
    dof: 0,
    freeAxes: {},
    nullSpaceBasis: [],
  }
  const vertexIds = Object.keys(vertices)
  const finalColumns = buildColumnIndex(vertexIds)
  const finalRows = activeRows(stagingGraph, tree)
  const x0 = flattenPositions(vertexIds, finalColumns, vertices)
  const solved = solveMinPerturbation(finalRows, finalColumns, x0)
  const solvedVertices = applyPositions(vertices, unflattenPositions(vertexIds, finalColumns, solved))
  return finalize({ ...stagingGraph, vertices: solvedVertices }, tree, hyperparams)
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
  const options = computePathOptions(pa, pb, bins, hyperparams.tilingPathOfferToleranceDeg)
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
  const existingRows = activeRows(graph, tree)
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
  return { graph: finalize({ ...graph, vertices, legs }, tree, hyperparams) }
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

  let workingVertices = graph.vertices
  let workingLegs = graph.legs
  let sharedSplitVertexId: string | null = null

  // A DIRECT occupant isn't a hard conflict the way an indirect one (below)
  // is -- a direct leg is just an unbroken straight line, and
  // `config.bendPoint` landing on it (strictly between its own two
  // endpoints) is a real point along that same line, not a competing
  // claim on the direction. Rather than erroring, split it there into two
  // direct sub-legs through a new vertex at the bend point -- same
  // "formalize an existing geometric fact" rationale as
  // `splitDirectLegsThroughNearbyVertices`, just triggered from path
  // creation instead of the running cleanup pass. Returns the new
  // (possibly shared, if both A and B split onto the same point) bend
  // vertex id, or `'blocked'` if the occupant is direct but the bend point
  // doesn't actually fall on its segment (at/beyond an endpoint, or off
  // the line) -- that's still a genuine conflict.
  function splitDirectOccupant(occupied: TilingLeg | undefined, vertexId: string): string | 'blocked' | null {
    if (!occupied || occupied.kind !== 'direct') return null
    const farId = otherEndpoint(occupied, vertexId)
    const a = workingVertices[vertexId]
    const c = workingVertices[farId]
    if (!a || !c) return 'blocked'
    const info = pointToSegmentInfo(config.bendPoint, a, c)
    if (info.perpDist >= hyperparams.tilingMinFeatureSize || info.t <= 1e-6 || info.t >= 1 - 1e-6) return 'blocked'
    const bendVertexId = sharedSplitVertexId ?? nanoid()
    if (!sharedSplitVertexId) {
      sharedSplitVertexId = bendVertexId
      workingVertices = {
        ...workingVertices,
        [bendVertexId]: { id: bendVertexId, kind: 'intermediate', x: config.bendPoint.x, y: config.bendPoint.y },
      }
    }
    const angle = legAngleAtVertex(occupied, vertexId)
    workingLegs = { ...workingLegs }
    delete workingLegs[occupied.id]
    const legToBend = nanoid()
    const legFromBend = nanoid()
    workingLegs[legToBend] = { id: legToBend, kind: 'direct', vertexA: vertexId, vertexB: bendVertexId, angle }
    workingLegs[legFromBend] = { id: legFromBend, kind: 'direct', vertexA: bendVertexId, vertexB: farId, angle }
    return bendVertexId
  }

  const splitA = splitDirectOccupant(occupiedA, vertexAId)
  const splitB = splitDirectOccupant(occupiedB, vertexBId)
  if (splitA === 'blocked' || splitB === 'blocked') {
    return { error: 'This path overlaps an existing direct path.' }
  }

  const mergeTargetA = splitA ?? (occupiedA ? otherEndpoint(occupiedA, vertexAId) : null)
  const mergeTargetB = splitB ?? (occupiedB ? otherEndpoint(occupiedB, vertexBId) : null)
  if (mergeTargetA && mergeTargetB && mergeTargetA !== mergeTargetB) {
    return { error: "Can't merge two different junctions in one step." }
  }
  // A duplicate is only real when BOTH sides already pointed at the same
  // pre-existing junction -- when they instead both landed there because
  // `splitDirectOccupant` just split two independent, previously
  // unconnected direct legs onto the same fresh bend point, that's a
  // brand-new connection (see the `splitA && splitB` branch below), not a
  // repeat of one that already existed.
  if (mergeTargetA && mergeTargetA === mergeTargetB && !splitA && !splitB) {
    return { error: 'This path already exists.' }
  }

  let newLegs: TilingLeg[]
  if (splitA && splitB) {
    // Both sides split onto the same shared bend vertex (`splitA ===
    // splitB` by construction -- `splitDirectOccupant` reuses
    // `sharedSplitVertexId` on its second call) -- those two splits
    // already provide both the A-bend and B-bend legs, so the requested
    // path is fully wired with nothing left to add.
    newLegs = []
  } else if (mergeTargetA) {
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
  const workingGraph: TilingGraphState = { ...graph, vertices: workingVertices, legs: workingLegs }
  const existingRows = activeRows(workingGraph, tree)
  const newRows = newLegs.map((leg) => legRow(leg.vertexA, leg.vertexB, leg.angle))
  // `newLegs` is empty exactly when both sides split onto the same shared
  // point above -- nothing new to rank-check (the splits already
  // formalized an existing geometric fact, same as
  // `splitDirectLegsThroughNearbyVertices`'s own no-rank-check
  // precedent). `tryAccept` treats zero new rows as an automatic reject
  // (its callers never used to pass an empty list), so it's skipped here
  // rather than misread as "this add would overconstrain the tiling."
  if (newLegs.length > 0 && !tryAccept(existingRows, newRows, columns)) {
    return { error: 'This path would overconstrain the tiling.' }
  }

  const x0 = flattenPositions(vertexIds, columns, workingVertices)
  const solved = solveMinPerturbation([...existingRows, ...newRows], columns, x0)
  const newPositions = unflattenPositions(vertexIds, columns, solved)

  if (segmentCrossesAny(Object.values(workingLegs), newLegs, newPositions)) {
    return { error: 'This path crosses an existing path.' }
  }

  const vertices = applyPositions(workingVertices, newPositions)
  const legs = { ...workingLegs }
  for (const leg of newLegs) legs[leg.id] = leg
  return { graph: finalize({ ...graph, vertices, legs }, tree, hyperparams) }
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

/** Deletes `legId` and cascades: an `intermediate` vertex only ever has
 * degree 0 or >=2, so if a removal drops one down to degree 1, its one
 * remaining leg (and then the vertex itself) is removed too -- this single
 * rule is exactly "a 2-legged path loses a leg -> drop both the other leg
 * and the vertex", and correctly leaves a 3+-leg junction alone when it
 * only drops to 2. Mutates `vertices`/`legs` in place. Shared by
 * `deleteTilingLeg` (the user-facing delete action) and the running
 * cleanup below (`dedupeDirectionsAt`'s "discard the longer duplicate-
 * direction leg" needs the identical cascade). */
function cascadeDeleteLeg(vertices: Record<string, TilingVertex>, legs: Record<string, TilingLeg>, legId: string): void {
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
}

/** True iff every real graph element a `HingeChainLock` depends on (both
 * sides' source tangent legs, every crossing's leg/vertex/node anchor, and
 * the common leg) still exists -- mirrors the `skeletonLocks` filter right
 * below this function's own callers, so a lock broken by a leg deletion
 * (directly, or via the intermediate-vertex cascade) is dropped at the same
 * time rather than left inert for `hingeChainLockRows` to silently no-op on
 * forever. */
function hingeChainLockIsLive(lock: HingeChainLock, legs: Record<string, TilingLeg>, vertices: Record<string, TilingVertex>): boolean {
  const anchorIsLive = (anchor: HingeChainLock['a']['crossings'][number]['anchor']): boolean => {
    if (anchor.kind === 'leg') return Boolean(legs[anchor.legId])
    if (anchor.kind === 'vertex') return Boolean(vertices[anchor.vertexId])
    return anchor.legIds.every((id) => legs[id])
  }
  const sideIsLive = (side: HingeChainLock['a']) =>
    side.sourceLegIds.every((id) => legs[id]) && side.crossings.every((c) => anchorIsLive(c.anchor))
  return sideIsLive(lock.a) && sideIsLive(lock.b) && Boolean(legs[lock.commonLegId])
}

/** Deleting a direct leg just drops its row; deleting an indirect leg can
 * cascade -- see `cascadeDeleteLeg`'s doc. */
export function deleteTilingLeg(graph: TilingGraphState, tree: TreeState, hyperparams: HyperparamsState, legId: string): TilingGraphState {
  const legs = { ...graph.legs }
  const vertices = { ...graph.vertices }
  cascadeDeleteLeg(vertices, legs, legId)

  // A lock referencing any leg removed above (directly, or via the
  // intermediate-vertex cascade) is no longer geometrically meaningful --
  // drop it now rather than leaving it inert for the live-geometry check in
  // `TilingEditorCanvas.tsx` to eventually notice.
  const skeletonLocks = graph.skeletonLocks.filter((lock) => lock.legIds.every((id) => legs[id]))
  const hingeChainLocks = graph.hingeChainLocks.filter((lock) => hingeChainLockIsLive(lock, legs, vertices))

  const vertexIds = Object.keys(vertices)
  const columns = buildColumnIndex(vertexIds)
  const nextGraph: TilingGraphState = { ...graph, vertices, legs, skeletonLocks, hingeChainLocks }
  const rows = activeRows(nextGraph, tree)
  const x0 = flattenPositions(vertexIds, columns, vertices)
  const solved = solveMinPerturbation(rows, columns, x0)
  const finalVertices = applyPositions(vertices, unflattenPositions(vertexIds, columns, solved))
  return finalize({ ...nextGraph, vertices: finalVertices }, tree, hyperparams)
}

/** Deletes every leg touching `vertexId` (one at a time, via
 * `deleteTilingLeg`'s existing cascade) -- for a flap vertex this just
 * un-tiles it (the vertex itself always remains, 1:1 with its tree leaf);
 * for an intermediate vertex it naturally disappears once its own last leg
 * goes. Mirrors the packing Inspector's delete button, generalized to not
 * need a kind-specific case split. */
export function deleteTilingVertexAndLegs(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
  vertexId: string,
): TilingGraphState {
  let current = graph
  const touching = () => Object.values(current.legs).filter((l) => l.vertexA === vertexId || l.vertexB === vertexId)
  let legsTouching = touching()
  while (legsTouching.length > 0) {
    current = deleteTilingLeg(current, tree, hyperparams, legsTouching[0].id)
    legsTouching = touching()
  }
  return current
}

function vertexDist(a: TilingVertex, b: TilingVertex): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** The first pair of vertices within `eps` of each other -- an all-pairs
 * scan (vertex counts are small, matching this file's other simple
 * non-indexed scans). Flap-flap pairs are skipped entirely: a flap is
 * "created once at seed time and never removed by any tiling-editing
 * operation" (see this module's top doc), so two flaps getting close is
 * never a merge candidate, only ever a fact about the current drag. When
 * one side is a flap it's always returned as `survivorId` (the flap is
 * never removable); between two `intermediate` vertices either can be the
 * survivor, so the choice is arbitrary but deterministic (whichever is
 * found first in iteration order). */
function findMergeCandidate(vertices: Record<string, TilingVertex>, eps: number): { survivorId: string; victimId: string } | null {
  const list = Object.values(vertices)
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]
      const b = list[j]
      if (a.kind === 'flap' && b.kind === 'flap') continue
      if (vertexDist(a, b) >= eps) continue
      if (a.kind === 'flap') return { survivorId: a.id, victimId: b.id }
      if (b.kind === 'flap') return { survivorId: b.id, victimId: a.id }
      return { survivorId: a.id, victimId: b.id }
    }
  }
  return null
}

/** Removes any leg-direction collision at `vertexId` that a merge may have
 * just introduced -- if two or more of its own legs (pre-existing plus
 * whatever `mergeVertexInto` just transferred in) land in the same
 * direction bin, keeps only the geometrically shortest (current Euclidean
 * endpoint distance) and `cascadeDeleteLeg`s the rest, per the request's
 * "only keep/transfer the shorter edge and discard the longer one." Loops
 * since discarding one duplicate can't create another at this same vertex,
 * but re-scans rather than assuming a single pass catches every bin. */
function dedupeDirectionsAt(vertices: Record<string, TilingVertex>, legs: Record<string, TilingLeg>, vertexId: string, bins: BinGeometry): void {
  let changed = true
  while (changed) {
    changed = false
    const touching = Object.values(legs).filter((l) => l.vertexA === vertexId || l.vertexB === vertexId)
    const byBin = new Map<number, TilingLeg[]>()
    for (const leg of touching) {
      const bin = binIndex(legAngleAtVertex(leg, vertexId), bins)
      const list = byBin.get(bin) ?? []
      list.push(leg)
      byBin.set(bin, list)
    }
    for (const list of byBin.values()) {
      if (list.length < 2) continue
      const ranked = list
        .map((leg) => ({ leg, length: vertexDist(vertices[leg.vertexA], vertices[leg.vertexB]) }))
        .sort((x, y) => x.length - y.length)
      for (const { leg } of ranked.slice(1)) cascadeDeleteLeg(vertices, legs, leg.id)
      changed = true
      break
    }
  }
}

/** Merges `victimId` (always `intermediate`) into `survivorId` (a flap or
 * another `intermediate` vertex) -- the two are within the running
 * cleanup's `eps` of each other by construction. Deletes the leg directly
 * connecting them if one exists (the "an indirect leg approaches 0" case),
 * then re-points every other leg touching `victimId` onto `survivorId`.
 * `angle` is left untouched on every re-pointed leg -- matching this
 * module's "a leg's angle is set once, never recomputed from position"
 * invariant, and accurate here to within the same `eps` the merge trigger
 * itself used. Replaces each re-pointed leg with a new object rather than
 * mutating it in place, since `legs`'s entries are shared with whatever
 * committed graph triggered this cleanup. Finishes by resolving any same-
 * direction collision the transfer just created at the survivor (see
 * `dedupeDirectionsAt`). Mutates `vertices`/`legs` in place. */
function mergeVertexInto(
  vertices: Record<string, TilingVertex>,
  legs: Record<string, TilingLeg>,
  survivorId: string,
  victimId: string,
  bins: BinGeometry,
): void {
  const direct = Object.values(legs).find(
    (l) => (l.vertexA === survivorId && l.vertexB === victimId) || (l.vertexA === victimId && l.vertexB === survivorId),
  )
  if (direct) delete legs[direct.id]

  for (const leg of Object.values(legs)) {
    if (leg.vertexA === victimId) legs[leg.id] = { ...leg, vertexA: survivorId }
    else if (leg.vertexB === victimId) legs[leg.id] = { ...leg, vertexB: survivorId }
  }
  delete vertices[victimId]
  dedupeDirectionsAt(vertices, legs, survivorId, bins)
}

/** The first leg with some *other* vertex (not its own two endpoints)
 * landing within `eps` of its segment, strictly between the endpoints --
 * generalizes `splitDirectLegsThroughNearbyVertices` (seed-time-only,
 * direct legs only) to run continuously on any leg kind, kept as a
 * separate function so the already-validated seed-time behavior stays
 * structurally untouched even though both now read the same
 * `hyperparams.tilingMinFeatureSize` tolerance. Replaces
 * that one leg with two new legs through the found vertex, both keeping the
 * original `angle` (still collinear by construction, no re-derivation) and
 * `kind` (a plain label with no control-flow significance anywhere in this
 * codebase, so correct to preserve for an indirect leg too, unlike the
 * seed-time function which hardcodes `'direct'` because only direct legs
 * exist at that point in seeding). Returns `true` iff it changed something,
 * so the caller can loop to catch more than one vertex on the same segment
 * across iterations. Mutates `legs` in place (`vertices` untouched). */
function trySplitOnce(vertices: Record<string, TilingVertex>, legs: Record<string, TilingLeg>, eps: number): boolean {
  for (const leg of Object.values(legs)) {
    const a = vertices[leg.vertexA]
    const c = vertices[leg.vertexB]
    if (!a || !c) continue
    const hit = Object.values(vertices).find((v) => {
      if (v.id === leg.vertexA || v.id === leg.vertexB) return false
      const { t, perpDist } = pointToSegmentInfo(v, a, c)
      return t > 1e-6 && t < 1 - 1e-6 && perpDist < eps
    })
    if (!hit) continue

    const angle = legAngleAtVertex(leg, leg.vertexA)
    delete legs[leg.id]
    const id1 = nanoid()
    const id2 = nanoid()
    legs[id1] = { id: id1, kind: leg.kind, vertexA: leg.vertexA, vertexB: hit.id, angle }
    legs[id2] = { id: id2, kind: leg.kind, vertexA: hit.id, vertexB: leg.vertexB, angle }
    return true
  }
  return false
}

/** Running cleanup: called after every pointerup in the tiling editor (see
 * `state/store.ts`'s `runTilingCleanup` action) to repair near-degeneracies
 * a drag can introduce live -- the same two kinds `seedTilingGraph`'s Layer
 * 3 one-shot post-process already cleans up at seed time, generalized to
 * run continuously at a user-configurable `eps`
 * (`hyperparams.tilingMinFeatureSize`): any two vertices closer than `eps`
 * get merged (unless both are flaps -- see `findMergeCandidate`), and any
 * vertex within `eps` of an unrelated leg's segment splits that leg through
 * it (see `trySplitOnce`). Merge is tried before split each iteration
 * (mirroring Layer 3's own ordering rationale: a merge can create a new
 * split opportunity, so resolving it first avoids a split a subsequent
 * merge would immediately invalidate); the loop re-scans the mutated state
 * each time, so a cascade in either direction (a split's new vertex ending
 * up near something else; a merge's survivor landing near a third leg)
 * naturally resolves to a fixed point. Neither operation moves a vertex --
 * both are purely topological -- so positions are only re-solved once, at
 * the end, snapping everything back onto exact `Ax=b` consistency (a
 * transferred leg's angle, or a split's collinearity, is only accurate to
 * within `eps` until then). Returns `graph` unchanged (same reference) when
 * there's nothing to clean, so the caller can skip a `set()`. */
export function runTilingCleanup(graph: TilingGraphState, tree: TreeState, hyperparams: HyperparamsState, eps: number): TilingGraphState {
  const bins = binsFor(hyperparams, graph.constraints)
  if (!bins) return graph

  const vertices = { ...graph.vertices }
  const legs = { ...graph.legs }
  let changed = false
  const cap = 4 * Object.keys(vertices).length + 16 // mirrors computeStraightSkeleton's iteration-cap style
  for (let i = 0; i < cap; i++) {
    const merge = findMergeCandidate(vertices, eps)
    if (merge) {
      mergeVertexInto(vertices, legs, merge.survivorId, merge.victimId, bins)
      changed = true
      continue
    }
    if (trySplitOnce(vertices, legs, eps)) {
      changed = true
      continue
    }
    break
  }
  if (!changed) return graph

  const skeletonLocks = graph.skeletonLocks.filter((lock) => lock.legIds.every((id) => legs[id]))
  const hingeChainLocks = graph.hingeChainLocks.filter((lock) => hingeChainLockIsLive(lock, legs, vertices))
  const nextGraph: TilingGraphState = { ...graph, vertices, legs, skeletonLocks, hingeChainLocks }
  const vertexIds = Object.keys(vertices)
  const columns = buildColumnIndex(vertexIds)
  const rows = activeRows(nextGraph, tree)
  const x0 = flattenPositions(vertexIds, columns, vertices)
  const solved = solveMinPerturbation(rows, columns, x0)
  const finalVertices = applyPositions(vertices, unflattenPositions(vertexIds, columns, solved))
  return finalize({ ...nextGraph, vertices: finalVertices }, tree, hyperparams)
}

/** Rebuilds the graph's rows from a new `constraints` value and re-solves
 * unconditionally -- no rank-check gate, matching `build_base_rows`'s own
 * precedent (base/user-declared constraints are always added
 * unconditionally, trusting the caller not to offer an infeasible
 * combination; `solveMinPerturbation`'s least-squares degrades gracefully
 * even if a combination turns out inconsistent). */
function applyConstraintChange(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
  nextConstraints: ConstraintsState,
): TilingGraphState {
  const nextGraph: TilingGraphState = { ...graph, constraints: nextConstraints }
  const vertexIds = Object.keys(nextGraph.vertices)
  const columns = buildColumnIndex(vertexIds)
  const rows = activeRows(nextGraph, tree)
  const x0 = flattenPositions(vertexIds, columns, nextGraph.vertices)
  const solved = solveMinPerturbation(rows, columns, x0)
  const vertices = applyPositions(nextGraph.vertices, unflattenPositions(vertexIds, columns, solved))
  return finalize({ ...nextGraph, vertices }, tree, hyperparams)
}

function tilingLeafConstraint(graph: TilingGraphState, flapId: string): LeafConstraint {
  return graph.constraints.perLeaf[flapId] ?? NO_LEAF_CONSTRAINT
}

export function pinTilingVertexToSymmetry(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
  flapId: string,
): Result<TilingGraphState> {
  const mode = graph.constraints.symmetryMode
  if (mode === 'none') return { error: 'Turn on symmetry mode in the packing editor first.' }
  const candidate: LeafConstraint = { ...tilingLeafConstraint(graph, flapId), symmetry: { kind: 'pin_symmetry' } }
  const res = resolveLeafConstraint(mode, candidate)
  if (!res.feasible) return { error: "This vertex's edge/corner pin can't be combined with symmetry in this mode." }
  const nextConstraints = withPinSymmetry(graph.constraints, flapId)
  if (res.point && findPointCollision(collectResolvedPoints(tree, nextConstraints), res.point, flapId)) {
    return { error: 'That position is already occupied by another vertex.' }
  }
  return { graph: applyConstraintChange(graph, tree, hyperparams, nextConstraints) }
}

export function pinTilingVertexToEdge(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
  flapId: string,
  edge: EdgeSide,
): Result<TilingGraphState> {
  const candidate: LeafConstraint = { ...tilingLeafConstraint(graph, flapId), boundary: { kind: 'pin_edge', edge } }
  const res = resolveLeafConstraint(graph.constraints.symmetryMode, candidate)
  if (!res.feasible) return { error: "That edge can't be combined with this vertex's symmetry pin." }
  const nextConstraints = withPinEdge(graph.constraints, flapId, edge)
  if (findAnyCollision(collectResolvedPoints(tree, nextConstraints))) {
    return { error: 'That position is already occupied by another vertex.' }
  }
  return { graph: applyConstraintChange(graph, tree, hyperparams, nextConstraints) }
}

export function pinTilingVertexToCorner(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
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
  return { graph: applyConstraintChange(graph, tree, hyperparams, nextConstraints) }
}

export function clearTilingVertexSymmetry(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
  flapId: string,
): TilingGraphState {
  return applyConstraintChange(graph, tree, hyperparams, withClearedSymmetry(graph.constraints, flapId))
}

export function clearTilingVertexBoundary(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
  flapId: string,
): TilingGraphState {
  return applyConstraintChange(graph, tree, hyperparams, withClearedBoundary(graph.constraints, flapId))
}

export function toggleTilingVertexLock(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
  flapId: string,
): TilingGraphState {
  const current = tilingLeafConstraint(graph, flapId)
  if (current.locked.kind === 'locked') {
    return applyConstraintChange(graph, tree, hyperparams, withClearedLock(graph.constraints, flapId))
  }
  // Same guard as the packing Inspector's toggleLock: nothing new to freeze
  // if symmetry+boundary already fully fix it, and a pair's follower's
  // position is always derived from its leader regardless of its own lock.
  if (isFullyFixedBySymmetryBoundary(graph.constraints.symmetryMode, current)) return graph
  if (current.symmetry.kind === 'pair' && flapId > current.symmetry.pairedWith) return graph
  const vertex = graph.vertices[flapId]
  if (!vertex) return graph
  return applyConstraintChange(graph, tree, hyperparams, withLocked(graph.constraints, flapId, { x: vertex.x, y: vertex.y }))
}

/** Locks (or, when called with a union of two existing locked/unlocked
 * vertices' edge sets, merges) a straight-skeleton incircle vertex: adds
 * `n - 3` cotangent rows for `legIds` (see `geometry/tilingCotangent.ts`) and
 * immediately re-solves, same `tryAccept`-gate-then-solve shape as
 * `addDirectLeg`. Absorbs (drops) any existing lock that's a subset of the
 * new edge set rather than stacking a redundant extra one -- the case a
 * "merge" hits when either endpoint of the merged ridge was already
 * individually locked.
 *
 * Every edge's cotangency row needs a face-boundary-consistent inward
 * direction, not just its own stored `vertexA -> vertexB` direction (which
 * is independent of which way any given face's CCW boundary walk happens to
 * traverse it -- a leg shared by two faces is traversed oppositely by
 * each). Finding the one face all `legIds` sit on and reading each edge's
 * `entryVertexId` off of *that* face's boundary order (rather than trusting
 * the caller) is both how the orientation gets fixed and how a caller
 * mistake (edges that don't all belong to one face) gets caught early. */
export function setSkeletonLock(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
  legIds: string[],
): Result<TilingGraphState> {
  const deduped = Array.from(new Set(legIds))
  if (deduped.length < 4) return { error: 'Need at least 4 edges to lock a cotangent incircle.' }
  if (!deduped.every((id) => graph.legs[id])) return { error: 'One of the selected edges no longer exists.' }

  const legsList = Object.values(graph.legs)
  const face = computeFaces(graph.vertices, legsList).find((f) => {
    const faceLegIds = legIdByFaceEdge(f, legsList)
    return deduped.every((id) => faceLegIds.includes(id))
  })
  if (!face) return { error: "These edges don't all sit on a single face." }
  const faceLegIds = legIdByFaceEdge(face, legsList)
  const entryVertexIds = deduped.map((legId) => face.vertexIds[faceLegIds.indexOf(legId)])
  const pairs = deduped.map((legId, i) => ({ legId, entryVertexId: entryVertexIds[i] }))

  const otherLocks = graph.skeletonLocks.filter((lock) => !lock.legIds.every((id) => deduped.includes(id)))
  const vertexIds = Object.keys(graph.vertices)
  const columns = buildColumnIndex(vertexIds)
  const existingRows = [...allBaseRows(graph, tree), ...legRows(graph), ...lockRows({ ...graph, skeletonLocks: otherLocks })]
  const newRows = slidingQuadruplets(pairs).flatMap((quad) => {
    const row = cotangentRow(
      quad.map(({ legId, entryVertexId }) => ({ vertexId: entryVertexId, angle: legAngleAtVertex(graph.legs[legId], entryVertexId) })),
    )
    return row ? [row] : []
  })
  if (newRows.length === 0) return { error: "These edges' directions don't admit a common incircle." }
  if (!tryAccept(existingRows, newRows, columns)) {
    return { error: 'Locking this vertex would overconstrain the tiling.' }
  }

  const x0 = flattenPositions(vertexIds, columns, graph.vertices)
  const solved = solveMinPerturbation([...existingRows, ...newRows], columns, x0)
  const vertices = applyPositions(graph.vertices, unflattenPositions(vertexIds, columns, solved))

  // A least-squares solve always finds *some* point satisfying the linear
  // cotangency rows (see `lockRows`'s doc -- once accepted, always exactly
  // satisfied), but that's necessary, not sufficient, for a genuine
  // positive-radius common incircle: the same homogeneous linear system is
  // equally satisfied by the degenerate limit of every edge collapsing to
  // one point (radius 0). Recomputing the real wavefront simulation on the
  // solved positions is the only way to tell "a sensible nearby merge"
  // apart from "the selected edges were too far apart, so least-squares
  // reached for the nearest degenerate solution instead" -- reject the
  // latter outright (no state change committed) rather than silently
  // applying it.
  const previewFace = computeFaces(vertices, legsList).find((f) => f.id === face.id)
  const previewLegIds = previewFace && legIdByFaceEdge(previewFace, legsList)
  const previewSkeleton = previewFace && computeStraightSkeleton(previewFace.vertexIds.map((id) => vertices[id]))
  const found = previewSkeleton?.nodes.some((node) => {
    const nodeLegIds = node.tangentEdges.map((i) => previewLegIds?.[i]).filter((x): x is string => x != null)
    return deduped.every((id) => nodeLegIds.includes(id))
  })
  if (!found) {
    return { error: 'These vertices are too far apart to merge into one point -- try moving them closer first.' }
  }

  const skeletonLocks: SkeletonLock[] = [...otherLocks, { legIds: deduped, entryVertexIds }]
  return { graph: finalize({ ...graph, vertices, skeletonLocks }, tree, hyperparams) }
}

/** Drops the lock matching `legIds` exactly (no re-solve of positions needed
 * -- dropping a constraint can't violate anything, only loosen the null
 * space; `finalize` recomputes `dof`/`freeAxes`/`nullSpaceBasis` for the
 * now-smaller row set). */
export function unlockSkeletonVertex(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
  legIds: string[],
): TilingGraphState {
  const sig = signatureOf(legIds)
  const skeletonLocks = graph.skeletonLocks.filter((lock) => signatureOf(lock.legIds) !== sig)
  return finalize({ ...graph, skeletonLocks }, tree, hyperparams)
}

/** Drops any lock whose signature no longer appears among `liveSignatures`
 * -- the reactive half of "if the vertex is no longer part of the straight
 * skeleton... the constraint is released": the algebraic rows stay exactly
 * satisfied for as long as they're included (see `activeRows`'s doc), but
 * the *topological* wavefront simulation (`computeStraightSkeleton`) can
 * still stop producing a node with this exact tangent-edge set if some
 * other edge's event pre-empts it -- that can only be detected against the
 * live computed skeleton, which only `TilingEditorCanvas.tsx` has, so this
 * is called reactively from there rather than from any committed edit.
 * Returns `graph` unchanged (same reference) when nothing needs dropping,
 * so callers can skip a `set()` when nothing changed. */
export function pruneStaleSkeletonLocks(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
  liveSignatures: Set<string>,
): TilingGraphState {
  const kept = graph.skeletonLocks.filter((lock) => liveSignatures.has(signatureOf(lock.legIds)))
  if (kept.length === graph.skeletonLocks.length) return graph
  return finalize({ ...graph, skeletonLocks: kept }, tree, hyperparams)
}

/** Stable identity for one `HingeChainLock`, for matching against a
 * specific lock the user clicked (`unlockHingeChainLock`) without relying
 * on object identity, which a round trip through the store wouldn't
 * preserve. */
function hingeChainLockSignature(lock: HingeChainLock): string {
  return `${signatureOf(lock.a.sourceLegIds)}|${signatureOf(lock.b.sourceLegIds)}|${lock.commonLegId}`
}

/** True iff the EXACT chain identified by `(sourceLegIds, tangentLegId)`
 * still connects across the lock in `chains` -- either it still crosses
 * `commonLegId` (the ordinary case), OR it now terminates directly at
 * `otherSourceLegIds`' own skeleton vertex (the "hinge merge equivalent to
 * a vertex merge" case: when the two locked sources end up close enough,
 * each side's OWN hinge can legitimately stop right at the other source
 * instead of continuing on to the far-away common leg -- e.g. two vertical
 * hinge chains locked collinear through some shared horizontal leg can
 * converge so that the lower source's "up" hinge and the upper source's
 * "down" hinge meet each other directly, becoming one shared chain between
 * the two sources, while each source's OTHER hinge continues on past it
 * exactly as before. That's a strictly BETTER outcome than "still reaches
 * the common leg", not a failure, so it must count as success here too).
 * Used by both `setHingeChainLock`'s post-solve re-verify and
 * `pruneStaleTilingHingeChainLocks`'s reactive release. `chains` must be the
 * RAW, undeduped list (`computeLiveHingeChains(..., false)`): a successful
 * merge can legitimately make this exact chain and its counterpart become
 * mutual reverses of each other post-solve, which the deduped list would
 * collapse to a single surviving id, making a signature-only "does some
 * chain from this source reach the common leg" check unreliable right when
 * the lock actually succeeded -- looking up this specific id in the raw
 * list sidesteps that entirely, since nothing is ever dropped there. */
function chainReachesCommonLeg(
  chains: HingeChain[],
  sourceLegIds: string[],
  tangentLegId: string,
  commonLegId: string,
  otherSourceLegIds: string[],
): boolean {
  const sig = signatureOf(sourceLegIds)
  const otherSig = signatureOf(otherSourceLegIds)
  const chain = chains.find((c) => c.tangentLegId === tangentLegId && signatureOf(c.sourceLegIds) === sig)
  if (!chain) return false
  if (chain.crossings.some((cr) => cr.anchor.kind === 'leg' && cr.anchor.legId === commonLegId)) return true
  return chain.termination.kind === 'skeletonVertex' && signatureOf(chain.termination.legIds) === otherSig
}

/**
 * True iff `a` and `b` are two DIFFERENT skeleton nodes' tangent-leg sets
 * that are ridge-adjacent -- each has exactly one tangent leg the other
 * lacks, with everything else shared. This is the standard shape of a
 * straight-skeleton edge (ridge) between two ordinary nodes: node U's
 * incircle is tangent to 2 edges shared with its ridge-neighbor V plus one
 * edge unique to U, and vice versa. Returns the union (a single cotangency
 * group covering both) when adjacent, `null` otherwise (including when `a`
 * and `b` are the very same node).
 */
function ridgeAdjacentUnion(a: string[], b: string[]): string[] | null {
  const setA = new Set(a)
  const setB = new Set(b)
  const onlyA = a.filter((id) => !setB.has(id))
  const onlyB = b.filter((id) => !setA.has(id))
  if (onlyA.length !== 1 || onlyB.length !== 1) return null
  return Array.from(new Set([...a, ...b]))
}

/**
 * The chain-collinearity lock: given two hinge chains (selected by the
 * user, see `state/store.ts`'s `selectTilingHingeChain`) that share a
 * common crossed leg, forces them collinear through it -- see
 * `geometry/hingeChainLock.ts`'s module doc for the underlying math. Single
 * preview -> verify -> commit function, no separate preview/commit pair,
 * matching `setSkeletonLock`'s own shape exactly.
 *
 * **Ridge-adjacent sources are a special case handled first**: if the two
 * chains' SOURCE vertices are themselves ridge-adjacent (`ridgeAdjacentUnion`
 * above), nudging their hinges collinear at some downstream leg is exactly
 * equivalent to merging the two source vertices into one shared-incircle
 * point -- the ridge between them is what's actually shrinking to zero, not
 * some independent crossing further out. In fact for a pair like this,
 * `findCommonLeg` below routinely can't find any shared crossed leg at all
 * (each source's "other" hinge heads off in a different direction from the
 * ridge, away from the other), even though merging the two vertices is
 * obviously the right, well-behaved operation the user is asking for. This
 * case is delegated wholesale to `setSkeletonLock` (union of both tangent-
 * leg sets) -- it's already exactly the right math (a cotangency lock IS a
 * vertex merge), already handles its own preview/verify/"too far apart"
 * checks, and already renders as a lock ring with no new UI needed here
 * (matching the user-visible distinction: a ridge-adjacent merge shows as a
 * ring around the merged vertex, an ordinary chain lock shows as a thick
 * connector line).
 */
export function setHingeChainLock(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
  chainA: HingeChain,
  chainB: HingeChain,
): Result<TilingGraphState> {
  if (signatureOf(chainA.sourceLegIds) !== signatureOf(chainB.sourceLegIds)) {
    const merged = ridgeAdjacentUnion(chainA.sourceLegIds, chainB.sourceLegIds)
    if (merged) return setSkeletonLock(graph, tree, hyperparams, merged)
  }

  const commonLegId = findCommonLeg(chainA, chainB)
  if (!commonLegId) return { error: "These two hinge chains don't cross a common path leg." }

  // A source with 4+ tangent legs must ALSO be a genuine shared-incircle
  // vertex for this chain's own math to remain meaningful going forward
  // (see `geometry/hingeChainLock.ts`'s module doc) -- reuse the existing
  // skeleton-lock machinery wholesale rather than re-deriving face-finding
  // and entry-vertex orientation here; this is also exactly what makes the
  // lock ring + Inspector unlock button appear for these sources with no
  // new UI code.
  let current = graph
  for (const sourceLegIds of [chainA.sourceLegIds, chainB.sourceLegIds]) {
    if (sourceLegIds.length < 4) continue
    const locked = setSkeletonLock(current, tree, hyperparams, sourceLegIds)
    if ('error' in locked) return locked
    current = locked.graph
  }

  const built = buildHingeChainConstraint(chainA, chainB, commonLegId, current)
  if ('error' in built) return built

  const vertexIds = Object.keys(current.vertices)
  const columns = buildColumnIndex(vertexIds)
  const existingRows = activeRows(current, tree)
  if (!tryAccept(existingRows, [built.row], columns)) {
    return { error: 'Locking this connection would overconstrain the tiling.' }
  }
  const x0 = flattenPositions(vertexIds, columns, current.vertices)
  const solved = solveMinPerturbation([...existingRows, built.row], columns, x0)
  const vertices = applyPositions(current.vertices, unflattenPositions(vertexIds, columns, solved))

  // Same rationale as `setSkeletonLock`'s own re-verify: the linear row
  // alone can't distinguish "a small, sensible snap" from "these hinges
  // were too far apart, so least-squares reached for whatever satisfies
  // the equation regardless of distance" -- recomputing the real chains on
  // the solved positions and confirming both still reach `commonLegId` is
  // the only way to tell those apart.
  const liveChains = computeLiveHingeChains({ ...current, vertices }, hyperparams, false)
  const stillReaches =
    chainReachesCommonLeg(liveChains, chainA.sourceLegIds, chainA.tangentLegId, commonLegId, chainB.sourceLegIds) &&
    chainReachesCommonLeg(liveChains, chainB.sourceLegIds, chainB.tangentLegId, commonLegId, chainA.sourceLegIds)
  if (!stillReaches) {
    return { error: 'These hinges are too far apart to connect -- try moving them closer first.' }
  }

  const sideLock = (chain: HingeChain): HingeChainLock['a'] => {
    // Include the common-leg crossing itself (`idx + 1`, not `idx`) --
    // `geometry/hingeChainLock.ts`'s `walkToCommonLeg` re-derives this row
    // fresh on every `finalize` (see `hingeChainLockRows`) by searching
    // `crossings` for `commonLegId`; excluding that exact crossing would
    // make every future re-derivation fail to find it and silently drop
    // this lock's row from the constraint set -- the position solve at
    // creation time still looks correct (it uses the live, untruncated
    // chain directly, not this persisted copy), but the null space would
    // never actually incorporate the constraint, letting a later drag walk
    // right off it despite the crease having snapped correctly moments
    // earlier.
    const idx = chain.crossings.findIndex((c) => c.anchor.kind === 'leg' && c.anchor.legId === commonLegId)
    return {
      sourceLegIds: chain.sourceLegIds,
      sourceTangentAngles: chain.sourceTangentAngles,
      tangentLegId: chain.tangentLegId,
      initialAngle: chain.initialAngle,
      crossings: chain.crossings.slice(0, idx + 1),
    }
  }
  const newLock: HingeChainLock = { a: sideLock(chainA), b: sideLock(chainB), commonLegId }
  return { graph: finalize({ ...current, vertices, hingeChainLocks: [...current.hingeChainLocks, newLock] }, tree, hyperparams) }
}

/** Drops the lock matching `lock` exactly -- no re-solve needed, dropping a
 * constraint can only loosen the null space (same reasoning as
 * `unlockSkeletonVertex`). */
export function unlockHingeChainLock(
  graph: TilingGraphState,
  tree: TreeState,
  hyperparams: HyperparamsState,
  lock: HingeChainLock,
): TilingGraphState {
  const sig = hingeChainLockSignature(lock)
  const hingeChainLocks = graph.hingeChainLocks.filter((l) => hingeChainLockSignature(l) !== sig)
  return finalize({ ...graph, hingeChainLocks }, tree, hyperparams)
}

/** Reactive release of any `HingeChainLock` whose live geometry has broken
 * -- either side's source no longer reaching the common leg (the general
 * "if the source vertices are lost... or something else weird happens, the
 * constraint is released" case; a deleted leg is instead caught immediately
 * by `deleteTilingLeg`'s own cascade via `hingeChainLockIsLive`). Unlike
 * `pruneStaleSkeletonLocks` (which takes the canvas's already-computed
 * `liveSignatures` to avoid a redundant per-render recompute), this
 * recomputes the live chains itself -- it's called only once per mouseup
 * (see `state/store.ts`), not once per render, so the extra recompute is
 * cheap by comparison. Returns `graph` unchanged (same reference) when
 * nothing needs dropping. */
export function pruneStaleTilingHingeChainLocks(graph: TilingGraphState, tree: TreeState, hyperparams: HyperparamsState): TilingGraphState {
  if (graph.hingeChainLocks.length === 0) return graph
  const liveChains = computeLiveHingeChains(graph, hyperparams, false)
  const kept = graph.hingeChainLocks.filter(
    (lock) =>
      chainReachesCommonLeg(liveChains, lock.a.sourceLegIds, lock.a.tangentLegId, lock.commonLegId, lock.b.sourceLegIds) &&
      chainReachesCommonLeg(liveChains, lock.b.sourceLegIds, lock.b.tangentLegId, lock.commonLegId, lock.a.sourceLegIds),
  )
  if (kept.length === graph.hingeChainLocks.length) return graph
  return finalize({ ...graph, hingeChainLocks: kept }, tree, hyperparams)
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
  hyperparams: HyperparamsState,
): Record<string, { x: number; y: number }> {
  const current = graph.vertices[vertexId]
  if (!current) return {}
  const target = boundsExempt(current, hyperparams)
    ? desiredPosition
    : { x: clamp01(desiredPosition.x), y: clamp01(desiredPosition.y) }
  const desired = { dx: target.x - current.x, dy: target.y - current.y }
  const coeffs = fitNullSpaceCoefficients(graph.nullSpaceBasis, vertexId, desired)
  const vertexIds = Object.keys(graph.vertices)
  const delta = fullDeltaFromCoefficients(vertexIds, graph.nullSpaceBasis, coeffs)
  const t = computeMaxBoundedScale(graph.vertices, delta, hyperparams)

  // Omitting an entry for a vertex whose actual displacement this frame
  // rounds to zero (most of a large graph, on any given drag -- only the
  // dragged vertex's own null-space neighborhood typically has a nonzero
  // component) lets the caller (`store.ts`'s `dragTilingVertexTo`) skip
  // reallocating that vertex's object every single pointermove frame,
  // preserving its reference identity across frames it didn't move in --
  // purely a GC/downstream-memoization win, never a numeric behavior
  // change, since a below-epsilon displacement wouldn't have been visibly
  // different anyway.
  const out: Record<string, { x: number; y: number }> = {}
  for (const id of vertexIds) {
    const v = graph.vertices[id]
    const d = delta[id] ?? { dx: 0, dy: 0 }
    const dx = t * d.dx
    const dy = t * d.dy
    if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) continue
    out[id] = { x: v.x + dx, y: v.y + dy }
  }
  return out
}
