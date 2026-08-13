import type { ConstraintsState } from './constraints'
import type { PathOption } from '../geometry/tilingGraphOps'
import type { CrossingAnchor } from '../geometry/hingeChains'

export type TilingVertexKind = 'flap' | 'intermediate'

export interface TilingVertex {
  id: string
  kind: TilingVertexKind
  /** Present iff `kind === 'flap'` -- ties the vertex back to the tree leaf
   * it seeded from. Flap vertices are created once at seed time and never
   * removed by any tiling-editing operation. */
  flapId?: string
  x: number
  y: number
}

export type TilingLegKind = 'direct' | 'indirect'

export interface TilingLeg {
  id: string
  kind: TilingLegKind
  vertexA: string
  vertexB: string
  /** Committed direction from `vertexA` to `vertexB`, snapped to one of the
   * shape's discrete basis directions. Set once at creation and never
   * recomputed from position afterward -- see the module doc in
   * `state/actions/tilingGraphActions.ts` for why that invariant matters
   * (a leg's angle must never drift, even while dragging near a boundary). */
  angle: number
}

/** A user-declared cotangent-incircle constraint over `legIds.length >= 4`
 * legs -- see `geometry/tilingCotangent.ts`. `legIds`/`entryVertexIds` are
 * parallel arrays (arbitrary but fixed order, only used to build overlapping
 * 4-windows): `entryVertexIds[i]` is the vertex `legIds[i]` is considered
 * "outward from" for this lock's purposes -- i.e. the face-boundary-CCW
 * vertex that precedes it -- since a leg's own stored `vertexA`/`angle` is
 * independent of which way any given face's boundary walk happens to
 * traverse it, and the cotangency math needs every edge's *inward* normal
 * oriented consistently with the one face this lock lives on. */
export interface SkeletonLock {
  legIds: string[]
  entryVertexIds: string[]
}

/** One side (chain) of a `HingeChainLock` -- the source skeleton vertex's
 * own tangent legs, its fixed departure direction, and every bounce (leg OR
 * ridge, see `geometry/hingeChains.ts`'s `CrossingAnchor`) it crosses before
 * reaching the lock's common leg. `initialAngle` and each crossing's
 * `mirrorAngle`/`angleAfter` are fixed at lock-creation time and never
 * recomputed from position afterward -- same "set once" invariant as
 * `TilingLeg.angle` itself (see `state/actions/tilingGraphActions.ts`'s
 * module doc), and necessarily so here: unlike a leg's own angle or a
 * hop's `angleAfter` (both invariant to which of the two opposite
 * direction conventions describe a line, see `geometry/hingeChainLock.ts`'s
 * module doc), a chain's very first `initialAngle` is NOT sign-invariant --
 * it depends on which side of its tangent line the source vertex actually
 * sits, a genuinely position-dependent fact at the moment the lock is
 * created. A ridge crossing's `mirrorAngle` is likewise a fixed snapshot
 * (see `HingeCrossing`'s doc) since a ridge has no stored `.angle` of its
 * own to re-read later the way a leg does. `sourceTangentAngles` (parallel
 * to `sourceLegIds`) is similarly fixed for the same reason as `initialAngle`
 * -- see `HingeChain.sourceTangentAngles`'s doc: which side of a non-parallel
 * tangent line the source sits on is a real, position-dependent fact that
 * can only be resolved once, with real geometry in hand. `tangentLegId`
 * identifies exactly which of the source's tangent legs this side's hinge
 * departs from -- needed by `state/actions/tilingGraphActions.ts`'s
 * post-solve re-verify to look up this EXACT chain (by its stable,
 * position-independent id) in the raw, undeduped chain list, since a
 * successful merge can legitimately make this side's hinge and the other
 * side's hinge become exact mutual reverses of each other post-solve --
 * a real, intended outcome that the *deduped* chain list would collapse to
 * a single survivor, making a signature-only lookup for "the other side"
 * unreliable right when the lock actually succeeded. */
export interface HingeChainSideLock {
  sourceLegIds: string[]
  sourceTangentAngles: number[]
  tangentLegId: string
  initialAngle: number
  crossings: Array<{ anchor: CrossingAnchor; mirrorAngle: number; angleAfter: number }>
}

/** A user-created chain-collinearity lock -- see `geometry/hingeChainLock.ts`
 * and `state/actions/tilingGraphActions.ts`'s
 * `setHingeChainLock`/`unlockHingeChainLock`/`pruneStaleTilingHingeChainLocks`.
 * Forces chain `a` and chain `b` to cross `commonLegId` at the same point. */
export interface HingeChainLock {
  a: HingeChainSideLock
  b: HingeChainSideLock
  commonLegId: string
}

export interface TilingGraphState {
  vertices: Record<string, TilingVertex>
  legs: Record<string, TilingLeg>
  /** An independent copy of the packing's constraints, taken once at seed
   * time and edited from here on only via the tiling Inspector -- never
   * read back from, or written back to, the live packing `constraints`. */
  constraints: ConstraintsState
  /** User-locked straight-skeleton incircle vertices -- see
   * `geometry/tilingCotangent.ts` and `state/actions/tilingGraphActions.ts`'s
   * `setSkeletonLock`/`unlockSkeletonVertex`/`pruneStaleSkeletonLocks`. */
  skeletonLocks: SkeletonLock[]
  /** User-created chain-collinearity locks -- see `HingeChainLock`'s doc. */
  hingeChainLocks: HingeChainLock[]
  /** Dimension of the constraint matrix's null space -- the number of
   * remaining positional degrees of freedom across the whole graph. */
  dof: number
  freeAxes: Record<string, { x: boolean; y: boolean }>
  /** Orthonormal basis for the constraint matrix's null space, one entry
   * per free dimension -- each a sparse-ish map from vertex id to that
   * basis vector's (dx, dy) component at that vertex. Recomputed after
   * every committed graph mutation; stable for the duration of a single
   * drag gesture. */
  nullSpaceBasis: Array<Record<string, { dx: number; dy: number }>>
}

/** The up-to-3 candidate paths offered after shift-selecting a second
 * vertex -- see `geometry/tilingGraphOps.ts`'s `computePathOptions`. */
export interface TilingPathCandidates {
  vertexAId: string
  vertexBId: string
  options: PathOption[]
}
