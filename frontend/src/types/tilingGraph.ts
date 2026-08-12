import type { ConstraintsState } from './constraints'
import type { PathOption } from '../geometry/tilingGraphOps'

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
