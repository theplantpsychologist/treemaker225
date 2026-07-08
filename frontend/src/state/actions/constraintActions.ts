import type {
  BoundaryConstraint,
  ConstraintsState,
  CornerId,
  EdgeSide,
  LeafConstraint,
  SymmetryMode,
} from '../../types/constraints'
import { NO_LEAF_CONSTRAINT } from '../../types/constraints'
import { mirrorCorner, mirrorEdge } from '../../geometry/symmetry'

function getConstraint(perLeaf: Record<string, LeafConstraint>, leafId: string): LeafConstraint {
  return perLeaf[leafId] ?? NO_LEAF_CONSTRAINT
}

function setConstraint(perLeaf: Record<string, LeafConstraint>, leafId: string, next: LeafConstraint): void {
  if (next.symmetry.kind === 'none' && next.boundary.kind === 'none' && next.locked.kind === 'none') {
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

/** Removes a leaf's entire constraint (both slots), unlinking any pair
 * partner back to 'none' — for when a leaf stops being a leaf (e.g. it just
 * gained a child) and its constraint no longer makes sense. Returns a
 * human-readable warning when it actually removed something, so the caller
 * can surface it instead of silently dropping state. */
export function pruneLeafConstraint(
  state: ConstraintsState,
  leafId: string,
): { constraints: ConstraintsState; warning: string | null } {
  const existing = state.perLeaf[leafId]
  if (!existing) return { constraints: state, warning: null }
  const perLeaf = { ...state.perLeaf }
  unlinkPairPartner(perLeaf, leafId)
  delete perLeaf[leafId]
  return {
    constraints: { ...state, perLeaf },
    warning: 'Removed a constraint that no longer applied because its flap became a branch.',
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

/** Mirrors a boundary pin across the symmetry line — 'none' stays 'none'. A
 * pair's boundary pin is one logical constraint applied to both sides, never
 * independent, so every setter below propagates through this. */
export function mirrorBoundary(mode: SymmetryMode, boundary: BoundaryConstraint): BoundaryConstraint {
  if (boundary.kind === 'pin_edge') return { kind: 'pin_edge', edge: mirrorEdge(mode, boundary.edge) }
  if (boundary.kind === 'pin_corner') return { kind: 'pin_corner', corner: mirrorCorner(mode, boundary.corner) }
  return { kind: 'none' }
}

export function boundaryEquals(a: BoundaryConstraint, b: BoundaryConstraint): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'pin_edge' && b.kind === 'pin_edge') return a.edge === b.edge
  if (a.kind === 'pin_corner' && b.kind === 'pin_corner') return a.corner === b.corner
  return true
}

export function withPair(state: ConstraintsState, aId: string, bId: string): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  unlinkPairPartner(perLeaf, aId)
  unlinkPairPartner(perLeaf, bId)
  const aBoundary = getConstraint(perLeaf, aId).boundary
  const bBoundary = getConstraint(perLeaf, bId).boundary
  setConstraint(perLeaf, aId, { ...getConstraint(perLeaf, aId), symmetry: { kind: 'pair', pairedWith: bId } })
  setConstraint(perLeaf, bId, { ...getConstraint(perLeaf, bId), symmetry: { kind: 'pair', pairedWith: aId } })
  // If exactly one side already carried a boundary pin, mirror it onto the
  // other now that they're linked.
  if (aBoundary.kind !== 'none' && bBoundary.kind === 'none') {
    setConstraint(perLeaf, bId, { ...getConstraint(perLeaf, bId), boundary: mirrorBoundary(state.symmetryMode, aBoundary) })
  } else if (bBoundary.kind !== 'none' && aBoundary.kind === 'none') {
    setConstraint(perLeaf, aId, { ...getConstraint(perLeaf, aId), boundary: mirrorBoundary(state.symmetryMode, bBoundary) })
  }
  return { ...state, perLeaf }
}

export function withPinEdge(state: ConstraintsState, leafId: string, edge: EdgeSide): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  const current = getConstraint(perLeaf, leafId)
  const next: BoundaryConstraint = { kind: 'pin_edge', edge }
  setConstraint(perLeaf, leafId, { ...current, boundary: next })
  if (current.symmetry.kind === 'pair') {
    const partnerId = current.symmetry.pairedWith
    setConstraint(perLeaf, partnerId, {
      ...getConstraint(perLeaf, partnerId),
      boundary: mirrorBoundary(state.symmetryMode, next),
    })
  }
  return { ...state, perLeaf }
}

export function withPinCorner(state: ConstraintsState, leafId: string, corner: CornerId): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  const current = getConstraint(perLeaf, leafId)
  const next: BoundaryConstraint = { kind: 'pin_corner', corner }
  setConstraint(perLeaf, leafId, { ...current, boundary: next })
  if (current.symmetry.kind === 'pair') {
    const partnerId = current.symmetry.pairedWith
    setConstraint(perLeaf, partnerId, {
      ...getConstraint(perLeaf, partnerId),
      boundary: mirrorBoundary(state.symmetryMode, next),
    })
  }
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
  const current = getConstraint(perLeaf, leafId)
  setConstraint(perLeaf, leafId, { ...current, boundary: { kind: 'none' } })
  if (current.symmetry.kind === 'pair') {
    const partnerId = current.symmetry.pairedWith
    setConstraint(perLeaf, partnerId, { ...getConstraint(perLeaf, partnerId), boundary: { kind: 'none' } })
  }
  return { ...state, perLeaf }
}

/** Locking never mirrors onto a pair partner directly — the partner's
 * position is already derived via `collectResolvedPoints`'s existing
 * pair-reflection branch once the leader's own resolution yields a point
 * (locking is just another such source, alongside `pin_corner`). */
export function withLocked(state: ConstraintsState, leafId: string, point: { x: number; y: number }): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  setConstraint(perLeaf, leafId, { ...getConstraint(perLeaf, leafId), locked: { kind: 'locked', point } })
  return { ...state, perLeaf }
}

export function withClearedLock(state: ConstraintsState, leafId: string): ConstraintsState {
  const perLeaf = { ...state.perLeaf }
  setConstraint(perLeaf, leafId, { ...getConstraint(perLeaf, leafId), locked: { kind: 'none' } })
  return { ...state, perLeaf }
}
