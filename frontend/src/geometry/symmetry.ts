import type { CornerId, EdgeSide, SymmetryMode } from '../types/constraints'

export interface Point {
  x: number
  y: number
}

export function reflect(mode: SymmetryMode, p: Point): Point {
  if (mode === 'book') return { x: 1 - p.x, y: p.y }
  if (mode === 'diagonal') return { x: p.y, y: p.x }
  return p
}

export function projectOntoLine(mode: SymmetryMode, p: Point): Point {
  if (mode === 'book') return { x: 0.5, y: p.y }
  if (mode === 'diagonal') {
    const m = (p.x + p.y) / 2
    return { x: m, y: m }
  }
  return p
}

/** Which edge a pin on `edge` lands on after reflecting across the symmetry
 * line — derived from `reflect`: book keeps top/bottom fixed and swaps
 * left/right (reflecting only flips x); diagonal swaps top<->right and
 * bottom<->left (reflecting swaps x and y, and the unit square is y-up —
 * see `geometry/edgePin.ts` — so 'top' is y=1, 'right' is x=1: reflecting
 * (s,1) gives (1,s), the right edge). */
export function mirrorEdge(mode: SymmetryMode, edge: EdgeSide): EdgeSide {
  if (mode === 'book') {
    if (edge === 'left') return 'right'
    if (edge === 'right') return 'left'
    return edge
  }
  if (mode === 'diagonal') {
    if (edge === 'top') return 'right'
    if (edge === 'right') return 'top'
    if (edge === 'bottom') return 'left'
    if (edge === 'left') return 'bottom'
  }
  return edge
}

/** Which corner a pin on `corner` lands on after reflecting across the
 * symmetry line — book swaps left<->right corners; diagonal fixes
 * top_right/bottom_left (the corners the diagonal line passes through in
 * this y-up unit square — see `geometry/edgePin.ts`) and swaps
 * top_left<->bottom_right. */
export function mirrorCorner(mode: SymmetryMode, corner: CornerId): CornerId {
  if (mode === 'book') {
    if (corner === 'top_left') return 'top_right'
    if (corner === 'top_right') return 'top_left'
    if (corner === 'bottom_left') return 'bottom_right'
    return 'bottom_left'
  }
  if (mode === 'diagonal') {
    if (corner === 'top_left') return 'bottom_right'
    if (corner === 'bottom_right') return 'top_left'
    return corner
  }
  return corner
}
