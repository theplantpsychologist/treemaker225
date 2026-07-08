export type SymmetryMode = 'none' | 'book' | 'diagonal'
export type EdgeSide = 'top' | 'bottom' | 'left' | 'right'
export type CornerId = 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right'

/** A leaf's symmetry-family constraint (whether/how it relates to the
 * global symmetry line) and boundary-family constraint (whether/how it's
 * pinned to the paper's edge/corner) are independent, simultaneously
 * settable slots — see `geometry/constraintResolution.ts` for the
 * feasibility/collision rules that govern combining them. */
export type SymmetryConstraint =
  | { kind: 'none' }
  | { kind: 'pin_symmetry' }
  | { kind: 'pair'; pairedWith: string }

export type BoundaryConstraint =
  | { kind: 'none' }
  | { kind: 'pin_edge'; edge: EdgeSide }
  | { kind: 'pin_corner'; corner: CornerId }

/** A third, orthogonal slot: freezes whatever positional degrees of freedom
 * the symmetry+boundary combo leaves free at a snapshot value, independent
 * of both other slots. */
export type LockConstraint = { kind: 'none' } | { kind: 'locked'; point: { x: number; y: number } }

export interface LeafConstraint {
  symmetry: SymmetryConstraint
  boundary: BoundaryConstraint
  locked: LockConstraint
}

export const NO_LEAF_CONSTRAINT: LeafConstraint = {
  symmetry: { kind: 'none' },
  boundary: { kind: 'none' },
  locked: { kind: 'none' },
}

export interface ConstraintsState {
  symmetryMode: SymmetryMode
  perLeaf: Record<string, LeafConstraint>
}

export const DEFAULT_CONSTRAINTS: ConstraintsState = {
  symmetryMode: 'none',
  perLeaf: {},
}
