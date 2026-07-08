import type { ShapeKind } from '../geometry/shapes'

export interface HyperparamsState {
  nRestarts: number
  nRefine: number
  alpha: number
  shape: ShapeKind
  /** Hexagon-only: an extra 90° rotation on top of whatever the symmetry
   * mode already applies (see `geometry/shapes.ts`'s `hexagonBases`). */
  hexagonExtraRotation: boolean
  seed?: number | null
}

export const DEFAULT_HYPERPARAMS: HyperparamsState = {
  nRestarts: 60,
  nRefine: 10,
  alpha: 100,
  shape: 'octagon',
  hexagonExtraRotation: false,
  seed: null,
}
