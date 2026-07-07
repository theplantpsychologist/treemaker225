import type { FlapConstraint } from '../types/constraints'

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

export function colorForConstraint(leafId: string, constraint: FlapConstraint | undefined): string {
  if (!constraint || constraint.kind === 'none') return COLOR_UNCONSTRAINED
  if (constraint.kind === 'pin_symmetry') return COLOR_SYMMETRY
  if (constraint.kind === 'pin_edge') return COLOR_EDGE
  if (constraint.kind === 'pin_corner') return COLOR_CORNER
  if (constraint.kind === 'pair') return pairColor(leafId, constraint.pairedWith)
  return COLOR_UNCONSTRAINED
}
