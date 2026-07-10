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
  /** Dodecagon-only: rotates it 15° (see `geometry/shapes.ts`'s
   * `dodecagonBases`). Same manual-toggle-with-diagonal-default mechanism as
   * `squareExtraRotation`. */
  dodecagonExtraRotation: boolean
  seed?: number | null
  solverMethod: SolverMethod
  /** Left unset (null) to use scipy's own per-method defaults. */
  tol?: number | null
  maxIter?: number | null
  /** Rendering-only ("active snapping threshold") — never meaningfully sent
   * to the backend (extra hyperparams fields are ignored server-side): how
   * far a leaf pair's actual center distance may drift from the tree-implied
   * tangency distance (scale * tree distance), as a fraction of that
   * distance, and still be drawn as an active path in the packing canvas. */
  activeSnapLengthTolerance: number
  /** Rendering-only: for non-circle shapes, how far (in degrees) an active
   * path's angle may drift from the nearest shape-face-normal-perpendicular
   * multiple and still render as a solid ("fully active") line rather than a
   * dashed semi-active parallelogram. */
  activeSnapAngleTolerance: number
  /** Only meaningful for a re-optimize (not the very first solve): the
   * largest per-restart random displacement applied to position variables,
   * ramping linearly from 0 (restart 0, the exact current layout) up to
   * this by the last restart — see backend `solve_service.py`'s basin-
   * hopping-style restart loop. Perturbation is deliberately allowed to
   * push a flap outside [0,1]. */
  maxNoiseAmplitude: number
}

export const DEFAULT_HYPERPARAMS: HyperparamsState = {
  nRestarts: 20,
  nRefine: 1,
  alpha: 100,
  shape: 'circle',
  hexagonExtraRotation: false,
  squareExtraRotation: false,
  dodecagonExtraRotation: false,
  seed: null,
  solverMethod: 'slsqp',
  tol: null,
  maxIter: null,
  activeSnapLengthTolerance: 0.1,
  activeSnapAngleTolerance: 10,
  maxNoiseAmplitude: 0.2,
}
