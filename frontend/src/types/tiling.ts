import type { NodePositionOut } from './solve'

export interface SelectedTilingPathOut {
  a: string
  b: string
}

export interface TilingVertexLegOut {
  flap: string
  angle: number
}

/** A junction where 2 (free bend) or 3+ (real, concurrency-constrained) legs
 * meet -- covers both kinds uniformly so rendering doesn't need a case
 * split: draw a line from each leg's flap to (x, y), plus a dot at (x, y). */
export interface TilingVertexOut {
  id: string
  x: number
  y: number
  legs: TilingVertexLegOut[]
}

export interface TilingResponse {
  status: 'ok' | 'error'
  message?: string | null
  leafPositions: NodePositionOut[]
  internalPositions: NodePositionOut[]
  selectedDirectPaths: SelectedTilingPathOut[]
  vertices: TilingVertexOut[]
}
