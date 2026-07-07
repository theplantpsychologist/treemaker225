import type { SymmetryMode } from '../types/constraints'

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
