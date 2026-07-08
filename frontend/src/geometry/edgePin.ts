import type { Point } from './symmetry'
import type { CornerId, EdgeSide } from '../types/constraints'

/** The unit square is math-convention y-up internally (y=0 at the bottom,
 * y=1 at the top) — `PackingEditorCanvas.tsx`/`geometry/rivers.ts` apply a
 * single compensating y-flip at the final screen-pixel conversion so "top"
 * still renders at the visual top, and the diagonal symmetry line (which
 * passes through bottom_left/top_right, not top_left/bottom_right) reads
 * as a bottom-left-to-top-right "/" instead of a "\". */
export function projectOntoEdge(edge: EdgeSide, p: Point): Point {
  switch (edge) {
    case 'left':
      return { x: 0, y: p.y }
    case 'right':
      return { x: 1, y: p.y }
    case 'top':
      return { x: p.x, y: 1 }
    case 'bottom':
      return { x: p.x, y: 0 }
  }
}

export function cornerPosition(corner: CornerId): Point {
  switch (corner) {
    case 'top_left':
      return { x: 0, y: 1 }
    case 'top_right':
      return { x: 1, y: 1 }
    case 'bottom_left':
      return { x: 0, y: 0 }
    case 'bottom_right':
      return { x: 1, y: 0 }
  }
}
