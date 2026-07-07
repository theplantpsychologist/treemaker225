export interface HyperparamsState {
  nRestarts: number
  nRefine: number
  alpha: number
  runOctagonRefinement: boolean
  seed?: number | null
}

export const DEFAULT_HYPERPARAMS: HyperparamsState = {
  nRestarts: 60,
  nRefine: 10,
  alpha: 100,
  runOctagonRefinement: true,
  seed: null,
}
