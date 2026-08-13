import type { Point } from './symmetry'
import type { SkeletonNode, StraightSkeletonResult } from './straightSkeleton'
import { computeHinges } from './straightSkeleton'
import { castHingeRay } from './hingeRayCast'
import type { PreparedMirror } from './hingeRayCast'
import { signatureOf } from './tilingCotangent'

/** Groups the raw per-hinge rays traced by `geometry/hingeRayCast.ts`'s
 * `castHingeRay` into selectable, stably-identified **chains** -- a chain is
 * one hinge's full path from its straight-skeleton source vertex until it
 * touches a real vertex (flap, intermediate, or another/its own skeleton
 * vertex) or runs off the paper, passing through (not stopping at) ordinary
 * leg/ridge crossings along the way. Also runs the dedup pass that drops a
 * hinge whenever it (or its mirror-image counterpart from the same source)
 * would double-cover the same physical crease -- see the module doc below
 * the type definitions for why the underlying math makes that safe. */

/** A face's straight skeleton with every node's own tangent legs already
 * resolved to real leg ids -- exactly the shape `TilingEditorCanvas.tsx`'s
 * `skeletonNodesWithLegIds` already builds (only nodes whose ENTIRE
 * `tangentEdges` set resolves are included, since a node's stable identity
 * -- `signatureOf(legIds)` -- needs the full set). */
export interface ResolvedSkeletonFace {
  faceId: string
  skeleton: StraightSkeletonResult
  nodes: { node: SkeletonNode; legIds: string[] }[]
}

/**
 * What a `HingeCrossing` bounced off. A `'leg'` anchor is a real tiling
 * graph leg -- the only kind eligible as a chain-collinearity lock's
 * "common leg" (`geometry/hingeChainLock.ts`'s `findCommonLeg`), since the
 * whole feature is specifically about two chains sharing an actual path
 * leg. `'vertex'`/`'node'` anchors are straight-skeleton RIDGE bounces
 * (the ray transmitted through a leg into a neighboring face and then
 * bounced off that face's own internal skeleton ridge before reaching its
 * next leg) -- a ridge has no real endpoint of its own to anchor a line
 * equation to, so it's resolved to whichever of ITS OWN two endpoints is
 * either a real boundary vertex (`'vertex'`) or another interior skeleton
 * node (`'node'`, identified the same way a chain's own source is: by its
 * full tangent-leg-id set). `geometry/hingeChainLock.ts`'s `walkToCommonLeg`
 * needs to walk through these too (not just leg crossings) since the
 * straight-line-hop assumption between two consecutive LEG crossings is
 * only valid when there's no intervening ridge bounce.
 *
 * `orientedAngles` (parallel to `legIds`) is that OTHER node's own tangent
 * legs' angles, each pre-oriented (flipped by pi from the leg's raw stored
 * `angle` if needed) to point from the leg's line toward this node's own
 * REAL, known position -- see `HingeChain.sourceTangentAngles`'s doc for why
 * this can only be done here, with real geometry in hand, not later in
 * `hingeChainLock.ts`. */
export type CrossingAnchor =
  | { kind: 'leg'; legId: string }
  | { kind: 'vertex'; vertexId: string }
  | { kind: 'node'; legIds: string[]; orientedAngles: number[] }

export interface HingeCrossing {
  anchor: CrossingAnchor
  point: Point
  /** The fixed direction of the mirror line crossed here -- `graph.legs[legId].angle`
   * for a `'leg'` anchor, or (for a ridge) that ridge segment's own current
   * numeric direction. A ridge's direction is, in principle, just as
   * position-independent as a leg's (it's the angle bisector of its two
   * adjacent tangent legs), but rather than re-derive that from the
   * surrounding leg angles, this just captures the concrete geometry at
   * chain-computation time as a fixed snapshot -- exactly how
   * `initialAngle`/`angleAfter` are already captured elsewhere in this
   * module. */
  mirrorAngle: number
  /** Direction of travel immediately after transmitting through this
   * crossing -- a fixed, position-independent hop angle (purely a function
   * of mirror angles, via `hingeRayCast.ts`'s `reflectAngle`), not derived
   * from `point`'s own coordinates. Used by `geometry/hingeChainLock.ts` to
   * walk a chain forward one crossing at a time. */
  angleAfter: number
}

/** Stable, position-independent string key for a `CrossingAnchor` --
 * matching two crossings' full anchor sequences (not just their `point`s,
 * which move during a solve) is how `TilingEditorCanvas.tsx`'s
 * `lockedConnectors` re-identifies which live chain a persisted
 * `HingeChainLock` side corresponds to. */
export function crossingKey(anchor: CrossingAnchor): string {
  if (anchor.kind === 'leg') return `leg:${anchor.legId}`
  if (anchor.kind === 'vertex') return `vertex:${anchor.vertexId}`
  return `node:${signatureOf(anchor.legIds)}`
}

export type ChainTermination =
  | { kind: 'vertex'; vertexId: string }
  | { kind: 'skeletonVertex'; legIds: string[] }
  | { kind: 'boundary' }
  | { kind: 'incomplete' }

export interface HingeChain {
  /** Stable across renders (including every drag frame) as long as topology
   * doesn't change -- built purely from leg ids, never from position. */
  id: string
  /** The source skeleton vertex's own tangent-leg id set. */
  sourceLegIds: string[]
  /** Each of `sourceLegIds`' own angle, pre-oriented (flipped by pi from the
   * leg's raw stored `angle` if needed) to point from the leg's line toward
   * the source's REAL, known position at the moment this chain was computed.
   * `geometry/hingeChainLock.ts`'s `solveSourcePoint` needs this: a 3-tangent-
   * line system taken as literally-stored (undirected) lines has, in
   * general, MULTIPLE algebraically valid solutions (which side of each
   * non-parallel line the point sits on is a real geometric fact, not
   * something derivable from the 3 line equations alone) -- only one of
   * which is the true incircle point. Resolving that ambiguity requires
   * comparing against an actual known position, which only exists HERE,
   * where the real straight-skeleton computation just ran; `hingeChainLock.ts`
   * only ever sees leg ids/angles, never positions, so it can't disambiguate
   * this later -- these angles must be captured now and treated as fixed
   * from here on, exactly like `TilingLeg.angle` itself. */
  sourceTangentAngles: number[]
  /** Which of the source's tangent legs this hinge points away from --
   * together with `sourceLegIds`, this is what makes `id` stable. */
  tangentLegId: string
  /** Direction of travel leaving the source, before any crossing -- like
   * `HingeCrossing.angleAfter`, a fixed function of leg angles alone. */
  initialAngle: number
  /** Full polyline, for rendering. */
  points: Point[]
  /** Every bounce along the chain, leg or ridge alike, in travel order --
   * `geometry/hingeChainLock.ts`'s `walkToCommonLeg` needs the full
   * sequence to correctly hop through the chain even when a ridge bounce
   * sits between two leg crossings. Only `anchor.kind === 'leg'` entries
   * are "hinge crossing points" in the user-facing sense (the ones
   * `findCommonLeg` and the Inspector's crossing count consider). */
  crossings: HingeCrossing[]
  termination: ChainTermination
}

const MIN_HINGE_LENGTH = 1e-7
/** How close (in radians) a chain's arrival direction must be to another
 * hinge's departure direction (mirrored, i.e. `+ pi`) before they're treated
 * as retracing the same physical crease -- see the dedup-pass doc below.
 * Loose enough to tolerate the accumulated floating-point drift of several
 * reflections, tight enough that two hinges landing at the same vertex from
 * genuinely different directions are never confused. */
const DEDUP_ANGLE_TOLERANCE = 1e-3

function posKey(p: Point): string {
  return `${p.x}|${p.y}`
}

function normalizeAngle(theta: number): number {
  let t = theta % (2 * Math.PI)
  if (t <= -Math.PI) t += 2 * Math.PI
  if (t > Math.PI) t -= 2 * Math.PI
  return t
}

function angleDiff(a: number, b: number): number {
  return Math.abs(normalizeAngle(a - b))
}

type TerminationCandidate =
  | { point: Point; info: { kind: 'vertex'; vertexId: string } }
  | { point: Point; info: { kind: 'skeletonVertex'; legIds: string[] } }

function classifyTermination(
  termination: ReturnType<typeof castHingeRay>['termination'],
  candidates: TerminationCandidate[],
): ChainTermination {
  if (termination.kind === 'vertex') return candidates[termination.vertexIndex].info
  if (termination.kind === 'boundary') return { kind: 'boundary' }
  return { kind: 'incomplete' }
}

/**
 * Drops a hinge chain whenever it (or its mirror-image counterpart from the
 * same source vertex) would double-cover the same physical crease.
 *
 * **Rationale**: ray propagation here (straight travel + Kawasaki
 * "transmission" reflection at each crossing -- see `hingeRayCast.ts`'s
 * `reflectAngle`) is a deterministic, *reversible* function of a starting
 * point + direction. If chain A departs its source and, after some number
 * of crossings, arrives near a skeleton vertex W along a direction that is
 * exactly antiparallel to some *other* chain B's own initial departure
 * direction from W, then by reversibility chain B's entire forward path
 * must retrace chain A's entire path, point for point, in reverse, all the
 * way back to A's own source. Keeping both A and B would draw the
 * identical set of crease segments twice. Whenever this fires, it
 * necessarily fires symmetrically (checking from B's side finds the same
 * pair), so the tie-break below (keep the lexicographically smaller `id`)
 * is applied consistently regardless of which one triggered the check --
 * and stays stable across renders, since it never depends on position,
 * only on leg ids. Compares the full `id` (source signature + tangentLegId),
 * not `tangentLegId` alone: two adjacent faces sharing an edge routinely
 * each have their own hinge whose `tangentLegId` IS that same shared edge
 * (it's a tangent leg from both sides), so comparing `tangentLegId` alone
 * would compare a string to itself and always take the "else" branch,
 * dropping both sides of the pair instead of exactly one.
 *
 * Exported on its own (separate from `computeHingeChains`, which calls this
 * internally) so it's directly testable against hand-built chains, without
 * needing a real straight skeleton + ray-casting setup to exercise it.
 */
export function dedupeHingeChains(raw: Array<{ chain: HingeChain; initialAngle: number }>): HingeChain[] {
  const toDrop = new Set<number>()
  for (let i = 0; i < raw.length; i++) {
    const ci = raw[i].chain
    if (ci.termination.kind !== 'skeletonVertex') continue
    if (ci.points.length < 2) continue
    const last = ci.points[ci.points.length - 1]
    const secondLast = ci.points[ci.points.length - 2]
    const arrivalAngle = Math.atan2(last.y - secondLast.y, last.x - secondLast.x)
    const targetSig = signatureOf(ci.termination.legIds)

    for (let j = 0; j < raw.length; j++) {
      if (j === i) continue
      const cj = raw[j].chain
      if (signatureOf(cj.sourceLegIds) !== targetSig) continue
      if (angleDiff(raw[j].initialAngle, arrivalAngle + Math.PI) > DEDUP_ANGLE_TOLERANCE) continue
      if (ci.id < cj.id) toDrop.add(j)
      else toDrop.add(i)
    }
  }
  return raw.filter((_, idx) => !toDrop.has(idx)).map((r) => r.chain)
}

/**
 * Builds every `HingeChain` across `faces` (one per skeleton node x tangent
 * leg, via `castHingeRay`), then runs `dedupeHingeChains` over the result --
 * unless `dedupe` is explicitly `false`. Rendering/selection always wants
 * the deduped list (so a double-covered crease reads as one line, see
 * `dedupeHingeChains`'s doc); a chain-collinearity lock's post-solve
 * re-verify (`state/actions/tilingGraphActions.ts`'s `setHingeChainLock`)
 * deliberately wants the RAW, undeduped list instead -- a successful merge
 * can legitimately cause the two locked hinges to become exact mutual
 * reverses of each other (a real, INTENDED outcome, not a bug), which the
 * dedup pass would then collapse down to whichever single id happens to
 * sort first, silently dropping the OTHER chain's own id from the result
 * and making a per-id "does chain X still cross the common leg" check
 * falsely fail for it, even though the underlying geometry is exactly the
 * small, correct snap it was supposed to be.
 */
export function computeHingeChains(
  faces: ResolvedSkeletonFace[],
  legMirrors: PreparedMirror[],
  legIdByMirrorIndex: string[],
  ridgeMirrors: PreparedMirror[],
  boundary: PreparedMirror[],
  tilingVertices: { id: string; x: number; y: number }[],
  vertexEps: number,
  maxBounces: number,
  dedupe = true,
): HingeChain[] {
  const candidates: TerminationCandidate[] = [
    ...tilingVertices.map((v) => ({ point: { x: v.x, y: v.y }, info: { kind: 'vertex' as const, vertexId: v.id } })),
    ...faces.flatMap(({ nodes }) =>
      nodes.map(({ node, legIds }) => ({ point: node.position, info: { kind: 'skeletonVertex' as const, legIds } })),
    ),
  ]
  const vertexPoints = candidates.map((c) => c.point)

  // Global (cross-face) lookups for resolving a RIDGE bounce's anchor --
  // once the ray transmits through a leg into a neighboring face, any
  // ridge it subsequently bounces off belongs to THAT face's own skeleton,
  // not the chain's source face, so this has to span every face, not just
  // the current one (unlike `nodeByPosKey` below, which is deliberately
  // per-face). A ridge's endpoint is always EXACTLY either an original
  // boundary vertex's position or another interior node's position (see
  // `straightSkeleton.ts`'s `closeRidge`/`applyEdgeEvent`/`applySplitEvent`,
  // which construct ridges directly from those same point values, never a
  // recomputed copy), so exact-string `posKey` matching is safe here, same
  // as the per-face hinge-origin lookup already relies on below.
  const vertexByPosKey = new Map<string, string>()
  for (const v of tilingVertices) vertexByPosKey.set(posKey({ x: v.x, y: v.y }), v.id)
  const nodeByPosKeyGlobal = new Map<string, { legIds: string[]; position: Point }>()
  for (const { nodes } of faces) for (const n of nodes) nodeByPosKeyGlobal.set(posKey(n.node.position), { legIds: n.legIds, position: n.node.position })

  // For disambiguating a tangent line's normal direction -- see
  // `HingeChain.sourceTangentAngles`'s doc for why this needs a REAL known
  // position and can't be done later, position-free, in `hingeChainLock.ts`.
  const mirrorByLegId = new Map<string, PreparedMirror>()
  legIdByMirrorIndex.forEach((legId, i) => mirrorByLegId.set(legId, legMirrors[i]))
  function orientedAngleFor(legId: string, nodePos: Point): number {
    const mirror = mirrorByLegId.get(legId)
    if (!mirror) return 0
    const rawAngle = Math.atan2(mirror.ey, mirror.ex)
    const nx = -Math.sin(rawAngle)
    const ny = Math.cos(rawAngle)
    const dot = nx * (nodePos.x - mirror.a.x) + ny * (nodePos.y - mirror.a.y)
    return dot >= 0 ? rawAngle : rawAngle + Math.PI
  }
  function orientedAnglesFor(legIds: string[], nodePos: Point): number[] {
    return legIds.map((legId) => orientedAngleFor(legId, nodePos))
  }

  function ridgeAnchor(p: Point): CrossingAnchor | null {
    const vertexId = vertexByPosKey.get(posKey(p))
    if (vertexId) return { kind: 'vertex', vertexId }
    const node = nodeByPosKeyGlobal.get(posKey(p))
    if (node) return { kind: 'node', legIds: node.legIds, orientedAngles: orientedAnglesFor(node.legIds, node.position) }
    return null
  }

  const raw: Array<{ chain: HingeChain; initialAngle: number }> = []
  for (const { skeleton, nodes } of faces) {
    const nodeByPosKey = new Map<string, { node: SkeletonNode; legIds: string[] }>()
    for (const n of nodes) nodeByPosKey.set(posKey(n.node.position), n)

    const hinges = computeHinges(nodes.map((n) => n.node), skeleton.edges).filter(
      (h) => Math.hypot(h.to.x - h.from.x, h.to.y - h.from.y) >= MIN_HINGE_LENGTH,
    )
    for (const hinge of hinges) {
      const owner = nodeByPosKey.get(posKey(hinge.from))
      if (!owner) continue
      const tangentIdx = owner.node.tangentEdges.indexOf(hinge.edgeIndex)
      const tangentLegId = tangentIdx === -1 ? undefined : owner.legIds[tangentIdx]
      if (!tangentLegId) continue

      const initialAngle = Math.atan2(hinge.to.y - hinge.from.y, hinge.to.x - hinge.from.x)
      const result = castHingeRay(hinge.from, initialAngle, legMirrors, ridgeMirrors, boundary, vertexPoints, vertexEps, maxBounces)
      // `result.points[0]` is the origin and `result.points[i + 1]` is
      // `result.bounces[i]`'s own point -- every entry in `bounces` is
      // non-terminal EXCEPT possibly the very last one, which fires when a
      // leg happens to run exactly along the physical paper edge (see
      // `hingeRayCast.ts`'s doc): the ray still terminates there (there's
      // no paper beyond it to transmit into), so `result.points[i + 2]`
      // doesn't exist for that trailing entry. `angleAfter` is meaningless
      // in that case (there's nothing after), but it's never read for a
      // chain's own LAST crossing (see `hingeChainLock.ts`'s `walkToCommonLeg`,
      // which only reads `angleAfter` when continuing past a crossing) --
      // fall back to the crossing's own incoming direction, a harmless
      // placeholder, rather than crashing on the missing point.
      //
      // Every bounce (leg AND ridge) becomes a crossing here -- see
      // `HingeChain.crossings`'s doc for why `walkToCommonLeg` needs the
      // full sequence. A ridge bounce whose anchor can't be resolved (the
      // rare exact-multi-way-tie edge case `straightSkeleton.ts`'s
      // `mergeCoincidentNodes` can leave behind) simply ends crossing
      // tracking early for this hinge, rather than recording an unusable
      // entry -- a graceful degradation (this hinge just can't serve as
      // one side of a chain-collinearity lock past that point), not a
      // crash.
      const crossings: HingeCrossing[] = []
      for (let i = 0; i < result.bounces.length; i++) {
        const b = result.bounces[i]
        const mirror = b.mirrorKind === 'leg' ? legMirrors[b.mirrorIndex] : ridgeMirrors[b.mirrorIndex]
        const mirrorAngle = Math.atan2(mirror.ey, mirror.ex)
        const next: Point | undefined = result.points[i + 2]
        const prev = result.points[i]
        const angleAfter = next
          ? Math.atan2(next.y - b.point.y, next.x - b.point.x)
          : Math.atan2(b.point.y - prev.y, b.point.x - prev.x)
        if (b.mirrorKind === 'leg') {
          crossings.push({ anchor: { kind: 'leg', legId: legIdByMirrorIndex[b.mirrorIndex] }, point: b.point, mirrorAngle, angleAfter })
          continue
        }
        const anchor = ridgeAnchor(mirror.a)
        if (!anchor) break
        crossings.push({ anchor, point: b.point, mirrorAngle, angleAfter })
      }

      raw.push({
        chain: {
          id: `${signatureOf(owner.legIds)}::${tangentLegId}`,
          sourceLegIds: owner.legIds,
          sourceTangentAngles: orientedAnglesFor(owner.legIds, hinge.from),
          tangentLegId,
          initialAngle,
          points: result.points,
          crossings,
          termination: classifyTermination(result.termination, candidates),
        },
        initialAngle,
      })
    }
  }

  return dedupe ? dedupeHingeChains(raw) : raw.map((r) => r.chain)
}
