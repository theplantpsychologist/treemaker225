export type SymmetryMode = 'none' | 'book' | 'diagonal'
export type EdgeSide = 'top' | 'bottom' | 'left' | 'right'
export type CornerId = 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right'

export type FlapConstraint =
  | { kind: 'none' }
  | { kind: 'pin_symmetry' }
  | { kind: 'pair'; pairedWith: string }
  | { kind: 'pin_edge'; edge: EdgeSide }
  | { kind: 'pin_corner'; corner: CornerId }

export interface ConstraintsState {
  symmetryMode: SymmetryMode
  perLeaf: Record<string, FlapConstraint>
}

export const DEFAULT_CONSTRAINTS: ConstraintsState = {
  symmetryMode: 'none',
  perLeaf: {},
}
