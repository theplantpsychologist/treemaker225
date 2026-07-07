import type { ConstraintsState, CornerId, EdgeSide, FlapConstraint, SymmetryMode } from '../../types/constraints'

function unlinkIfPaired(perLeaf: Record<string, FlapConstraint>, leafId: string): void {
  const c = perLeaf[leafId]
  if (c?.kind === 'pair') {
    const partner = c.pairedWith
    const partnerConstraint = perLeaf[partner]
    if (partnerConstraint?.kind === 'pair' && partnerConstraint.pairedWith === leafId) {
      perLeaf[partner] = { kind: 'none' }
    }
  }
  perLeaf[leafId] = { kind: 'none' }
}

export function withSymmetryMode(state: ConstraintsState, mode: SymmetryMode): ConstraintsState {
  let perLeaf = state.perLeaf
  if (mode === 'none') {
    perLeaf = Object.fromEntries(
      Object.entries(perLeaf).map(([id, c]) => [
        id,
        c.kind === 'pin_symmetry' || c.kind === 'pair' ? ({ kind: 'none' } as FlapConstraint) : c,
      ]),
    )
  }
  return { symmetryMode: mode, perLeaf }
}

export function withPinSymmetry(state: ConstraintsState, leafId: string): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  unlinkIfPaired(perLeaf, leafId)
  perLeaf[leafId] = { kind: 'pin_symmetry' }
  return { ...state, perLeaf }
}

export function withPair(state: ConstraintsState, aId: string, bId: string): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  unlinkIfPaired(perLeaf, aId)
  unlinkIfPaired(perLeaf, bId)
  perLeaf[aId] = { kind: 'pair', pairedWith: bId }
  perLeaf[bId] = { kind: 'pair', pairedWith: aId }
  return { ...state, perLeaf }
}

export function withPinEdge(state: ConstraintsState, leafId: string, edge: EdgeSide): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  unlinkIfPaired(perLeaf, leafId)
  perLeaf[leafId] = { kind: 'pin_edge', edge }
  return { ...state, perLeaf }
}

export function withPinCorner(state: ConstraintsState, leafId: string, corner: CornerId): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  unlinkIfPaired(perLeaf, leafId)
  perLeaf[leafId] = { kind: 'pin_corner', corner }
  return { ...state, perLeaf }
}

export function withClearedConstraint(state: ConstraintsState, leafId: string): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  unlinkIfPaired(perLeaf, leafId)
  return { ...state, perLeaf }
}
