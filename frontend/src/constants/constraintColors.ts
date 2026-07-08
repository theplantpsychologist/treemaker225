import type { BoundaryConstraint, LeafConstraint, SymmetryConstraint } from '../types/constraints'
import { NO_LEAF_CONSTRAINT } from '../types/constraints'

export const COLOR_UNCONSTRAINED = '#9aa0a6'
export const COLOR_SYMMETRY = '#17a2b8'
export const COLOR_EDGE = '#f4b400'
export const COLOR_CORNER = '#3f51b5'
export const COLOR_OVERLAP = '#db4437'

export const PAIR_PALETTE = ['#7c4dff', '#ff7043', '#ec407a', '#26a69a', '#8d6e63', '#5c6bc0']

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/** Deterministic color for a pair, shared by both partners, derived from their combined ids. */
export function pairColor(leafId: string, partnerId: string): string {
  const key = [leafId, partnerId].sort().join('|')
  return PAIR_PALETTE[hashString(key) % PAIR_PALETTE.length]
}

export function symmetryColor(leafId: string, symmetry: SymmetryConstraint): string {
  if (symmetry.kind === 'pin_symmetry') return COLOR_SYMMETRY
  if (symmetry.kind === 'pair') return pairColor(leafId, symmetry.pairedWith)
  return COLOR_UNCONSTRAINED
}

export function boundaryColor(boundary: BoundaryConstraint): string {
  if (boundary.kind === 'pin_edge') return COLOR_EDGE
  if (boundary.kind === 'pin_corner') return COLOR_CORNER
  return COLOR_UNCONSTRAINED
}

/** Primary swatch/stroke color for a flap that carries only one active
 * slot — the boundary family (edge/corner) takes precedence when both are
 * set, since it's the rarer, more visually distinctive pin; a secondary
 * indicator for the other family is layered on separately when both are
 * active (see `PackingEditorCanvas`'s flap rendering). */
export function colorForConstraint(leafId: string, constraint: LeafConstraint | undefined): string {
  const c = constraint ?? NO_LEAF_CONSTRAINT
  if (c.boundary.kind !== 'none') return boundaryColor(c.boundary)
  return symmetryColor(leafId, c.symmetry)
}
