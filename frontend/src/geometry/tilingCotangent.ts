import { columnKey, type Row } from './tilingLinAlg'

/** Cotangent-incircle constraint rows for the manual tiling editor's
 * lockable straight-skeleton vertices: forcing 4+ legs' committed lines to
 * stay tangent to one common circle. Re-derives, directly over this
 * codebase's real (x, y) vertex-position variables, the same linear-algebra
 * relation `prototypes/topology2tiling.py`'s `build_quadruplet_constraint_4d`
 * solves for its own 4D lattice coordinates -- see that file's docstring and
 * this plan's write-up for the derivation. No `ml-matrix` dependency: the
 * one linear-algebra step needed (the left null space of a 4x3 matrix) is a
 * fixed-size closed form (a 4D generalized cross product), not a general
 * SVD, so it's implemented directly rather than routed through
 * `tilingLinAlg.ts`'s SVD-based helpers (which are tuned for the large,
 * variable-shaped constraint matrix, not this tiny fixed-size one). */

const ZERO_EPS = 1e-9

/** The generalized cross product of 3 vectors in R^4 -- the unique (up to
 * scale) vector orthogonal to all three, via alternating-sign 3x3-minor
 * cofactor expansion (the direct 4D analogue of the 3D cross product's 2x2
 * minors). Returns the zero vector iff `a`, `b`, `c` are linearly dependent
 * (no such orthogonal complement direction is picked out). */
export function fourDCross(a: number[], b: number[], c: number[]): number[] {
  const rows = [a, b, c]
  const result: number[] = [0, 0, 0, 0]
  for (let skip = 0; skip < 4; skip++) {
    const idx = [0, 1, 2, 3].filter((i) => i !== skip)
    const m = rows.map((r) => idx.map((i) => r[i]))
    // 3x3 determinant of m (rows = a/b/c restricted to the 3 kept components).
    const det =
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    result[skip] = (skip % 2 === 0 ? 1 : -1) * det
  }
  return result
}

export interface CotangentEdge {
  vertexId: string
  angle: number
}

/** One linear row over vertex-position variables asserting that exactly 4
 * legs' committed lines are tangent to a common (signed) incircle -- see
 * this plan's derivation: for line normals `n_i = (-sin(angle_i),
 * cos(angle_i))` (matching `tilingGraphOps.ts`'s `legRow` convention) and a
 * representative point `p_i` on each line, a circle `(Q, r)` tangent to all
 * 4 satisfies `n_i . Q - r = n_i . p_i` -- 4 equations in 3 unknowns `(Qx,
 * Qy, r)`. A solution exists iff the RHS vector is orthogonal to the
 * coefficient matrix's 1-dim left null space `k`, which is exactly one
 * linear equation in the `p_i` (no `Q`/`r` unknowns survive). Returns `null`
 * if `k` comes out ~zero (the 4 lines' normals don't span a full-rank 4x3
 * system, e.g. a repeated/duplicate direction among the 4). */
export function cotangentRow(edges: CotangentEdge[]): Row | null {
  if (edges.length !== 4) throw new Error('cotangentRow requires exactly 4 edges')
  const nx = edges.map((e) => -Math.sin(e.angle))
  const ny = edges.map((e) => Math.cos(e.angle))
  const colR = [-1, -1, -1, -1]
  const k = fourDCross(nx, ny, colR)
  const mag = Math.hypot(...k)
  if (mag < ZERO_EPS) return null

  const coeffs: Record<string, number> = {}
  edges.forEach((e, i) => {
    coeffs[columnKey(e.vertexId, 'x')] = (coeffs[columnKey(e.vertexId, 'x')] ?? 0) + k[i] * nx[i]
    coeffs[columnKey(e.vertexId, 'y')] = (coeffs[columnKey(e.vertexId, 'y')] ?? 0) + k[i] * ny[i]
  })
  return { coeffs, b: 0 }
}

/** `n - 3` overlapping 4-windows covering all `n` edges (`n >= 4`) -- any
 * fixed order works, since consecutive windows share 3 edges and 3 signed
 * lines generically have a unique common signed-tangent circle, so
 * transitivity through each shared triple forces the whole chain onto one
 * circle (the same n-3-row scheme `topology2tiling.py`'s docstring
 * describes for its own MILP-selected quadruplets). */
export function slidingQuadruplets<T>(items: T[]): T[][] {
  const windows: T[][] = []
  for (let i = 0; i + 4 <= items.length; i++) windows.push(items.slice(i, i + 4))
  return windows
}

/** Stable identity for "a set of legs forming one incircle vertex" -- used
 * both to match a live straight-skeleton node against a persisted
 * `SkeletonLock` and to detect subset/subsumption when merging. */
export function signatureOf(legIds: string[]): string {
  return [...legIds].sort().join('|')
}
