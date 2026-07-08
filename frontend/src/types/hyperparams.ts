import type { ShapeKind } from '../geometry/shapes'

/** L-BFGS-B is deliberately not an option — see the comment at the top of
 * backend/app/core/packing.py for why it can't support this problem. */
export type SolverMethod = 'slsqp' | 'cobyla' | 'trust-constr'

export interface HyperparamsState {
  nRestarts: number
  nRefine: number
  alpha: number
  shape: ShapeKind
  /** Hexagon-only: an extra 90° rotation on top of whatever the symmetry
   * mode already applies (see `geometry/shapes.ts`'s `hexagonBases`). */
  hexagonExtraRotation: boolean
  /** Square-only: rotates it 45° into a diamond (see `geometry/shapes.ts`'s
   * `squareBases`). Manual toggle, defaulted on (but still overridable) the
   * moment shape=square+symmetryMode=diagonal newly becomes true — see
   * `state/store.ts`'s `setHyperparams`/`setSymmetryMode`. */
  squareExtraRotation: boolean
  seed?: number | null
  solverMethod: SolverMethod
  /** Left unset (null) to use scipy's own per-method defaults. */
  tol?: number | null
  maxIter?: number | null
}

export const DEFAULT_HYPERPARAMS: HyperparamsState = {
  nRestarts: 10,
  nRefine: 10,
  alpha: 100,
  shape: 'circle',
  hexagonExtraRotation: false,
  squareExtraRotation: false,
  seed: null,
  solverMethod: 'slsqp',
  tol: null,
  maxIter: null,
}
