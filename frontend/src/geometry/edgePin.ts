import type { Point } from './symmetry'
import type { CornerId, EdgeSide } from '../types/constraints'

export function projectOntoEdge(edge: EdgeSide, p: Point): Point {
  switch (edge) {
    case 'left':
      return { x: 0, y: p.y }
    case 'right':
      return { x: 1, y: p.y }
    case 'top':
      return { x: p.x, y: 0 }
    case 'bottom':
      return { x: p.x, y: 1 }
  }
}

export function cornerPosition(corner: CornerId): Point {
  switch (corner) {
    case 'top_left':
      return { x: 0, y: 0 }
    case 'top_right':
      return { x: 1, y: 0 }
    case 'bottom_left':
      return { x: 0, y: 1 }
    case 'bottom_right':
      return { x: 1, y: 1 }
  }
}
