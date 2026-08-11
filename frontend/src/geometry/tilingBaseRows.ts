import type { ConstraintsState, LeafConstraint, SymmetryMode } from '../types/constraints'
import type { Point } from './symmetry'
import { columnKey, type Row } from './tilingLinAlg'
import { resolveLeafConstraint } from './constraintResolution'

/** TypeScript port of `backend/app/core/tiling_rows.py`'s
 * `leaf_own_rows`/`pair_rows`/`build_base_rows` -- every user-specified
 * constraint (locked, boundary, symmetry, pairing) as rows over the
 * flap-position variables, reusing the existing `resolveLeafConstraint`
 * rather than re-deriving its feasibility/collapse logic. Convex-hull
 * auto-pinning is NOT included here (computed once at seed time and
 * frozen -- see `tilingGraphOps.ts`), unlike these, which are re-derived
 * fresh from `constraints` on every operation. */

function fixedPointRows(leafId: string, point: Point): Row[] {
  return [
    { coeffs: { [columnKey(leafId, 'x')]: 1 }, b: point.x },
    { coeffs: { [columnKey(leafId, 'y')]: 1 }, b: point.y },
  ]
}

export function leafOwnRows(leafId: string, constraint: LeafConstraint, mode: SymmetryMode): Row[] {
  const res = resolveLeafConstraint(mode, constraint)
  if (!res.feasible) {
    throw new Error(`leaf ${leafId} has an infeasible symmetry/boundary combination`)
  }
  if (res.point) return fixedPointRows(leafId, res.point)

  if (constraint.symmetry.kind === 'pin_symmetry') {
    if (mode === 'book') return [{ coeffs: { [columnKey(leafId, 'x')]: 1 }, b: 0.5 }]
    if (mode === 'diagonal') {
      return [{ coeffs: { [columnKey(leafId, 'x')]: 1, [columnKey(leafId, 'y')]: -1 }, b: 0 }]
    }
  }
  if (constraint.boundary.kind === 'pin_edge') {
    const edge = constraint.boundary.edge
    if (edge === 'left' || edge === 'right') {
      return [{ coeffs: { [columnKey(leafId, 'x')]: 1 }, b: edge === 'left' ? 0 : 1 }]
    }
    return [{ coeffs: { [columnKey(leafId, 'y')]: 1 }, b: edge === 'bottom' ? 0 : 1 }]
  }
  return []
}

/** Two rows tying the follower's position to `reflect(mode, leader)`, in row
 * form -- book mirrors x=0.5 (`x_f + x_l = 1`, y unchanged); diagonal
 * mirrors x=y (`x_f = y_l`, `y_f = x_l`). */
export function pairRows(leaderId: string, followerId: string, mode: SymmetryMode): Row[] {
  if (mode === 'book') {
    return [
      { coeffs: { [columnKey(followerId, 'x')]: 1, [columnKey(leaderId, 'x')]: 1 }, b: 1 },
      { coeffs: { [columnKey(followerId, 'y')]: 1, [columnKey(leaderId, 'y')]: -1 }, b: 0 },
    ]
  }
  if (mode === 'diagonal') {
    return [
      { coeffs: { [columnKey(followerId, 'x')]: 1, [columnKey(leaderId, 'y')]: -1 }, b: 0 },
      { coeffs: { [columnKey(followerId, 'y')]: 1, [columnKey(leaderId, 'x')]: -1 }, b: 0 },
    ]
  }
  return []
}

export function buildBaseRows(leafIds: string[], constraints: ConstraintsState): Row[] {
  const rows: Row[] = []
  const mode = constraints.symmetryMode
  const seenPairs = new Set<string>()
  for (const leafId of leafIds) {
    const constraint = constraints.perLeaf[leafId]
    if (!constraint) continue
    rows.push(...leafOwnRows(leafId, constraint, mode))
    if (constraint.symmetry.kind === 'pair') {
      const partner = constraint.symmetry.pairedWith
      const pairKey = leafId < partner ? `${leafId}:${partner}` : `${partner}:${leafId}`
      if (seenPairs.has(pairKey)) continue
      seenPairs.add(pairKey)
      const [leader, follower] = leafId < partner ? [leafId, partner] : [partner, leafId]
      rows.push(...pairRows(leader, follower, mode))
    }
  }
  return rows
}
