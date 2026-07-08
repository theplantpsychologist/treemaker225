import type { ConstraintsState, CornerId, EdgeSide, LeafConstraint, SymmetryMode } from '../../types/constraints'
import { NO_LEAF_CONSTRAINT } from '../../types/constraints'

function getConstraint(perLeaf: Record<string, LeafConstraint>, leafId: string): LeafConstraint {
  return perLeaf[leafId] ?? NO_LEAF_CONSTRAINT
}

function setConstraint(perLeaf: Record<string, LeafConstraint>, leafId: string, next: LeafConstraint): void {
  if (next.symmetry.kind === 'none' && next.boundary.kind === 'none') {
    delete perLeaf[leafId]
  } else {
    perLeaf[leafId] = next
  }
}

/** If `leafId` is currently paired, severs the link on both sides (clearing
 * the partner's symmetry slot back to 'none', preserving its own boundary
 * slot) — called whenever a leaf's symmetry slot is about to be overwritten. */
function unlinkPairPartner(perLeaf: Record<string, LeafConstraint>, leafId: string): void {
  const c = perLeaf[leafId]
  if (c?.symmetry.kind !== 'pair') return
  const partnerId = c.symmetry.pairedWith
  const partnerC = perLeaf[partnerId]
  if (partnerC?.symmetry.kind === 'pair' && partnerC.symmetry.pairedWith === leafId) {
    setConstraint(perLeaf, partnerId, { ...partnerC, symmetry: { kind: 'none' } })
  }
}

export function withSymmetryMode(state: ConstraintsState, mode: SymmetryMode): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  if (mode === 'none') {
    for (const [id, c] of Object.entries(perLeaf)) {
      if (c.symmetry.kind === 'pin_symmetry' || c.symmetry.kind === 'pair') {
        setConstraint(perLeaf, id, { ...c, symmetry: { kind: 'none' } })
      }
    }
  }
  return { symmetryMode: mode, perLeaf }
}

export function withPinSymmetry(state: ConstraintsState, leafId: string): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  unlinkPairPartner(perLeaf, leafId)
  setConstraint(perLeaf, leafId, { ...getConstraint(perLeaf, leafId), symmetry: { kind: 'pin_symmetry' } })
  return { ...state, perLeaf }
}

export function withPair(state: ConstraintsState, aId: string, bId: string): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  unlinkPairPartner(perLeaf, aId)
  unlinkPairPartner(perLeaf, bId)
  setConstraint(perLeaf, aId, { ...getConstraint(perLeaf, aId), symmetry: { kind: 'pair', pairedWith: bId } })
  setConstraint(perLeaf, bId, { ...getConstraint(perLeaf, bId), symmetry: { kind: 'pair', pairedWith: aId } })
  return { ...state, perLeaf }
}

export function withPinEdge(state: ConstraintsState, leafId: string, edge: EdgeSide): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  setConstraint(perLeaf, leafId, { ...getConstraint(perLeaf, leafId), boundary: { kind: 'pin_edge', edge } })
  return { ...state, perLeaf }
}

export function withPinCorner(state: ConstraintsState, leafId: string, corner: CornerId): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  setConstraint(perLeaf, leafId, { ...getConstraint(perLeaf, leafId), boundary: { kind: 'pin_corner', corner } })
  return { ...state, perLeaf }
}

export function withClearedSymmetry(state: ConstraintsState, leafId: string): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  unlinkPairPartner(perLeaf, leafId)
  setConstraint(perLeaf, leafId, { ...getConstraint(perLeaf, leafId), symmetry: { kind: 'none' } })
  return { ...state, perLeaf }
}

export function withClearedBoundary(state: ConstraintsState, leafId: string): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  setConstraint(perLeaf, leafId, { ...getConstraint(perLeaf, leafId), boundary: { kind: 'none' } })
  return { ...state, perLeaf }
}
