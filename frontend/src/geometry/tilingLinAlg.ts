import { EigenvalueDecomposition, Matrix, SingularValueDecomposition } from 'ml-matrix'

/** Pure linear-algebra core for the manual tiling editor: sparse constraint
 * rows over vertex-position variables (flap AND intermediate vertices
 * alike), rank-checked incremental row acceptance, minimum-perturbation
 * least squares, and null-space extraction for the DOF display / drag
 * projection.
 *
 * A TypeScript port of `backend/app/core/tiling_rows.py`'s core -- run here
 * instead of on the backend so every tiling-editing operation (add/delete a
 * leg, drag a vertex) is synchronous with zero network round-trip. Uses
 * `ml-matrix`'s SVD for rank/least-squares, the same numerical approach
 * `tiling_rows.py` uses via `numpy.linalg.matrix_rank`/`lstsq` and for the
 * same reason (matrix entries are fixed real algebraic numbers -- sines/
 * cosines of snapped angles -- not free symbolic parameters, so an SVD-based
 * tolerance is the right tool, not a symbolic/modular rank trick).
 *
 * `ml-matrix`'s `SingularValueDecomposition` already reorients internally
 * (via `autoTranspose`) when there are more columns than rows -- our matrix
 * usually is wide (many vertices, few constraints) -- and its `.rank`
 * getter uses the same `max(m,n) * sigma_max * EPSILON` tolerance
 * convention numpy's `matrix_rank` default uses, so no separate tolerance
 * constant is needed here.
 */

export type Axis = 'x' | 'y'

export interface Row {
  /** Keyed by `` `${vertexId}:${axis}` `` (see `columnKey`). */
  coeffs: Record<string, number>
  b: number
}

export function columnKey(vertexId: string, axis: Axis): string {
  return `${vertexId}:${axis}`
}

export interface ColumnIndex {
  index: Record<string, number>
  nCols: number
}

export function buildColumnIndex(vertexIds: string[]): ColumnIndex {
  const index: Record<string, number> = {}
  vertexIds.forEach((id, i) => {
    index[columnKey(id, 'x')] = 2 * i
    index[columnKey(id, 'y')] = 2 * i + 1
  })
  return { index, nCols: 2 * vertexIds.length }
}

export function rowsToMatrix(rows: Row[], columns: ColumnIndex): { a: Matrix; b: number[] } {
  const a = Matrix.zeros(rows.length, columns.nCols)
  const b = new Array(rows.length).fill(0)
  rows.forEach((row, i) => {
    for (const [key, coeff] of Object.entries(row.coeffs)) {
      const col = columns.index[key]
      if (col === undefined) continue
      a.set(i, col, a.get(i, col) + coeff)
    }
    b[i] = row.b
  })
  return { a, b }
}

/** `undefined` for a 0-row matrix -- `SingularValueDecomposition` rejects
 * empty matrices, and rank/null-space callers special-case that themselves. */
function svdOf(a: Matrix): SingularValueDecomposition | undefined {
  if (a.rows === 0 || a.columns === 0) return undefined
  return new SingularValueDecomposition(a, {
    autoTranspose: true,
    computeLeftSingularVectors: true,
    computeRightSingularVectors: true,
  })
}

export function matrixRank(rows: Row[], columns: ColumnIndex): number {
  if (rows.length === 0) return 0
  const { a } = rowsToMatrix(rows, columns)
  const svd = svdOf(a)
  return svd ? svd.rank : 0
}

/** True iff appending `newRows` to `acceptedRows` increases the coefficient
 * matrix's rank by exactly `newRows.length` -- every new row is independent
 * of everything already accepted (and of each other). Ignores `b` (can't
 * distinguish "redundant and consistent" from "redundant and conflicting",
 * but the safe move -- don't add the row -- is the same either way). */
export function tryAccept(acceptedRows: Row[], newRows: Row[], columns: ColumnIndex): boolean {
  if (newRows.length === 0) return false
  const oldRank = matrixRank(acceptedRows, columns)
  const trialRank = matrixRank([...acceptedRows, ...newRows], columns)
  return trialRank === oldRank + newRows.length
}

/** min ||x - x0||^2 s.t. A x = b, via the SVD pseudo-inverse solve for
 * `A @ delta = b - A @ x0`. By construction of the caller's rank-checked
 * accept loop, `A` always has full row rank, so this is always exactly
 * solvable; `ml-matrix`'s `SVD.solve` returns the minimum-norm solution
 * directly, which is exactly the minimum-perturbation correction to `x0`. */
export function solveMinPerturbation(rows: Row[], columns: ColumnIndex, x0: number[]): number[] {
  if (rows.length === 0) return x0.slice()
  const { a, b } = rowsToMatrix(rows, columns)
  const svd = svdOf(a)
  if (!svd) return x0.slice()
  const residual = b.map((bi, i) => {
    let ax0 = 0
    for (let col = 0; col < columns.nCols; col++) ax0 += a.get(i, col) * x0[col]
    return bi - ax0
  })
  const delta = svd.solve(Matrix.columnVector(residual)).to1DArray()
  return x0.map((v, i) => v + delta[i])
}

/** Minimum-norm least-squares solution `c` (length `k`) to `B c ~= d`, where
 * `B` is the tiny `2 x k` matrix `[rowsX; rowsY]` -- used by the drag
 * projection to fit null-space-basis coefficients against a desired 2D
 * vertex delta. `k` is very commonly 0 or 1 (a vertex with zero or one free
 * axis), which makes the naive normal-equations approach (`c = Bᵗ(BBᵗ)⁻¹d`
 * via a hand-rolled 2x2 inverse) break down whenever `BBᵗ` is singular --
 * exactly the common case, not an edge case, so it's not a shortcut worth
 * taking. Going through the same SVD-based solve as everywhere else in
 * this module handles every rank of `B` (0, 1, or 2) uniformly. */
export function minNormSolve2xK(rowsX: number[], rowsY: number[], desired: { dx: number; dy: number }): number[] {
  const k = rowsX.length
  if (k === 0) return []
  const b = new Matrix([rowsX, rowsY])
  const svd = svdOf(b)
  if (!svd) return rowsX.map(() => 0)
  return svd.solve(Matrix.columnVector([desired.dx, desired.dy])).to1DArray()
}

/** Basis for `A`'s null space, dimension `nCols - rank(A)`. A 0-row matrix
 * has no constraints at all, so the whole space is free -- returned as the
 * standard basis.
 *
 * Deliberately NOT computed from `A`'s own SVD's trailing right-singular-
 * vector columns, despite that being the textbook approach (and what
 * `tiling_rows.py`'s numpy equivalent does): empirically, `ml-matrix`'s
 * `SingularValueDecomposition` does not reliably complete its `V` into a
 * genuinely full, orthogonal `nCols x nCols` matrix when `A` is wide (more
 * columns than rows -- our common case, many vertices vs. few
 * constraints) with `autoTranspose` off -- some of the "extra" columns
 * beyond the singular-value-bearing ones come out *not* orthogonal to the
 * row space, silently producing a "null space" vector that isn't actually
 * one (verified directly against `ml-matrix`, not a guess). Computing the
 * eigendecomposition of the symmetric `AᵗA` instead sidesteps that
 * rectangular-SVD-completion path entirely: for any real matrix,
 * `Av = 0 ⟺ AᵗAv = 0` (since `‖Av‖² = vᵗAᵗAv`), so the eigenvectors of
 * `AᵗA` with eigenvalue 0 are exactly `A`'s null space, and a symmetric
 * eigendecomposition (`assumeSymmetric: true`) has no economy/full
 * distinction to get wrong -- the eigenvector matrix is always the full
 * `nCols x nCols` orthonormal set. `rank` itself still comes from the
 * already-verified `matrixRank`/`svdOf` (`autoTranspose: true`) path, used
 * only to decide *how many* of `AᵗA`'s smallest-|eigenvalue| eigenvectors
 * to take -- not to extract the vectors themselves. */
export function nullSpaceBasis(rows: Row[], columns: ColumnIndex): number[][] {
  if (columns.nCols === 0) return []
  if (rows.length === 0) {
    return Array.from({ length: columns.nCols }, (_, i) =>
      Array.from({ length: columns.nCols }, (_, j) => (i === j ? 1 : 0)),
    )
  }
  const rank = matrixRank(rows, columns)
  const dim = columns.nCols - rank
  if (dim <= 0) return []

  const { a } = rowsToMatrix(rows, columns)
  const ata = a.transpose().mmul(a)
  const evd = new EigenvalueDecomposition(ata, { assumeSymmetric: true })
  const order = evd.realEigenvalues
    .map((value, index) => ({ value: Math.abs(value), index }))
    .sort((x, y) => x.value - y.value)

  const basis: number[][] = []
  for (let k = 0; k < dim; k++) {
    basis.push(evd.eigenvectorMatrix.getColumn(order[k].index))
  }
  return basis
}
