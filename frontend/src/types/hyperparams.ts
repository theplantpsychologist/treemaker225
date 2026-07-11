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
  /** Path-network snap solver (see backend app/core/path_network*.py) --
   * weight on the primary objective: maximize the number of selected
   * direct paths plus the number of active (degree>=3) intermediate
   * points, each counted once. Deliberately large relative to C1/C2/C3 so
   * this signal dominates -- there's no hard per-flap degree floor, so this
   * is what drives the solver to select anything at all. */
  pathNetworkCountWeight: number
  /** Weight on the flap-displacement penalty: C1 * (initial normalized leaf
   * length)^2 * |displacement|^2. */
  pathNetworkC1: number
  /** Weight on the length-change term: reward when a length grows relative
   * to the whole tree, penalty when it shrinks. */
  pathNetworkC2: number
  /** Weight on the small per-active-intermediate-point penalty, biasing the
   * solve toward fewer/simpler indirect bends. */
  pathNetworkC3: number
  /** How many outer continuation/annealing steps to run before giving up on
   * reaching a fully discrete (0/1) boolean relaxation. */
  pathNetworkAnnealOuterIters: number
  /** Initial weight of the boolean-relaxation entropy penalty; grows by
   * pathNetworkAnnealWeightGrowth every outer iteration. */
  pathNetworkAnnealWeightStart: number
  pathNetworkAnnealWeightGrowth: number
  /** Every relaxed boolean must land within this of 0 or 1 for the
   * continuation loop to stop early. */
  pathNetworkBoolEps: number
  /** Basin-hopping restarts wrapping the whole anneal+round+polish
   * pipeline, mirroring maxNoiseAmplitude's role for the main Optimize
   * button. */
  pathNetworkNRestarts: number
  pathNetworkMaxNoiseAmplitude: number
  /** Upper bound on any length variable, as a multiple of its initial
   * value -- without this, a length whose every pair got pruned from the
   * non-overlap check had nothing at all stopping it from growing without
   * limit under a nonzero pathNetworkC2. */
  pathNetworkGrowthCap: number
  /** Big-M slacks for the angle/length gated constraints at the start of
   * the anneal schedule -- angle starts tighter than length since an
   * off-angle crease is a worse defect than a slightly-off length. */
  pathNetworkMAngleStart: number
  pathNetworkMLengthStart: number
  /** Both M's shrink by this factor every outer anneal iteration, down to
   * pathNetworkMFloor. */
  pathNetworkMDecay: number
  pathNetworkMFloor: number
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
  pathNetworkCountWeight: 1.0,
  pathNetworkC1: 0.0,
  pathNetworkC2: 0.0,
  pathNetworkC3: 0.00,
  pathNetworkAnnealOuterIters: 6,
  pathNetworkAnnealWeightStart: 1.0,
  pathNetworkAnnealWeightGrowth: 3.0,
  pathNetworkBoolEps: 0.3,
  pathNetworkNRestarts: 1,
  pathNetworkMaxNoiseAmplitude: 0.0,
  pathNetworkGrowthCap: 3.0,
  pathNetworkMAngleStart: 2.0,
  pathNetworkMLengthStart: 4.0,
  pathNetworkMDecay: 0.5,
  pathNetworkMFloor: 0.05,
}
