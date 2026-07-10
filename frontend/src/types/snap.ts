import type { NodePositionOut } from './solve'

export interface NodeLengthOut {
  nodeId: string
  length: number
}

export interface SnapPathsResponse {
  status: 'ok' | 'error'
  message?: string | null
  leafPositions: NodePositionOut[]
  lengths: NodeLengthOut[]
  /** How many active (solid-line) paths were found and snapped -- 0 means
   * "nothing to do," surfaced by the store as a soft no-op uiError rather
   * than a hard failure. */
  snappedCount: number
}
