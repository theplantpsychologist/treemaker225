import type { NodePositionOut } from './solve'
import type { NodeLengthOut } from './snap'

export interface SelectedDirectPathOut {
  a: string
  b: string
}

/** One selected half-leg for the tiling canvas's view-only rendering -- a
 * straight segment from `flap`'s position to (x, y). Legs sharing the same
 * `pointId` terminate at the identical intermediate point. */
export interface SelectedLegOut {
  flap: string
  pointId: string
  x: number
  y: number
}

export interface PathNetworkResponse {
  status: 'ok' | 'error'
  message?: string | null
  leafPositions: NodePositionOut[]
  lengths: NodeLengthOut[]
  selectedDirectPaths: SelectedDirectPathOut[]
  selectedLegs: SelectedLegOut[]
}
