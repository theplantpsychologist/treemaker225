import type { ShapeKind } from '../geometry/shapes'

export interface HyperparamsState {
  nRestarts: number
  nRefine: number
  alpha: number
  shape: ShapeKind
  seed?: number | null
}

export const DEFAULT_HYPERPARAMS: HyperparamsState = {
  nRestarts: 60,
  nRefine: 10,
  alpha: 100,
  shape: 'octagon',
  seed: null,
}
