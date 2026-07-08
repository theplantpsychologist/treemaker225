import type { SymmetryMode } from '../types/constraints'

export type ShapeKind = 'circle' | 'square' | 'hexagon' | 'octagon' | 'dodecagon'

function regularNgonBases(n: number, angleOffset = 0): [number, number][] {
  const bases: [number, number][] = []
  for (let k = 0; k < n; k++) {
    const angle = angleOffset + (2 * Math.PI * k) / n
    bases.push([Math.cos(angle), Math.sin(angle)])
  }
  return bases
}

/** Preserved as the exact geometry the original octagon-only implementation used. */
export const OCT_BASES: [number, number][] = regularNgonBases(8)

export const SHAPE_BASES: Record<Exclude<ShapeKind, 'circle' | 'hexagon'>, [number, number][]> = {
  square: regularNgonBases(4),
  octagon: OCT_BASES,
  dodecagon: regularNgonBases(12),
}

/** Hexagon's angle offset is computed on demand rather than read from a
 * static table: diagonal symmetry rotates it 45° so its vertices (not just
 * its edges) line up with the mirror line, and the hexagon-only advanced
 * setting adds another 90° on top of that. A horizontal top/bottom edge in
 * the base (unrotated) orientation means a vertical face normal, hence the
 * base 90-degree offset. Cached per offset (only 4 combinations exist) so
 * repeated calls with the same inputs return the SAME array reference —
 * required because this flows into a direct Zustand selector
 * (`usePackingEditorInteraction.ts`), which treats a new reference on every
 * call as a state change and would otherwise re-render forever. */
const hexagonBasesCache = new Map<number, [number, number][]>()
function hexagonBases(symmetryMode: SymmetryMode, extraRotation: boolean): [number, number][] {
  let offset = Math.PI / 2
  if (symmetryMode === 'diagonal') offset += Math.PI / 4
  if (extraRotation) offset += Math.PI / 2
  let cached = hexagonBasesCache.get(offset)
  if (!cached) {
    cached = regularNgonBases(6, offset)
    hexagonBasesCache.set(offset, cached)
  }
  return cached
}

/** The separating-axis bases for `shape`, or null for 'circle' — the
 * degenerate case with no discrete bases (plain Euclidean distance).
 * `symmetryMode`/`extraRotation` only affect hexagon (see `hexagonBases`). */
export function getBases(
  shape: ShapeKind,
  symmetryMode: SymmetryMode = 'none',
  extraRotation = false,
): [number, number][] | null {
  if (shape === 'circle') return null
  if (shape === 'hexagon') return hexagonBases(symmetryMode, extraRotation)
  return SHAPE_BASES[shape]
}

/** Support-function radial multiplier: for a regular N-gon with unit
 * face-normals `bases`, the boundary along direction `dir` sits at distance
 * `apothem / maxProjection(dir)`. Returns 1 (plain distance) for a circle
 * (bases === null). */
export function maxProjection(dir: { x: number; y: number }, bases: readonly [number, number][] | null): number {
  if (!bases) return 1
  let best = -Infinity
  for (const [bx, by] of bases) {
    const proj = dir.x * bx + dir.y * by
    if (proj > best) best = proj
  }
  return best
}

const CIRCLE_SEGMENTS = 48

/** Vertices of `shape` centered at (cx, cy) whose apothem (or radius, for a
 * circle) equals `radius`. `symmetryMode`/`extraRotation` only affect
 * hexagon (see `hexagonBases`) — pass the live values so a rendered
 * hexagon's orientation always matches what the solver actually used. */
export function buildShapePoints(
  shape: ShapeKind,
  cx: number,
  cy: number,
  radius: number,
  symmetryMode: SymmetryMode = 'none',
  extraRotation = false,
): [number, number][] {
  if (shape === 'circle') {
    const points: [number, number][] = []
    for (let k = 0; k < CIRCLE_SEGMENTS; k++) {
      const angle = (2 * Math.PI * k) / CIRCLE_SEGMENTS
      points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)])
    }
    return points
  }
  const bases = getBases(shape, symmetryMode, extraRotation)!
  const n = bases.length
  const angleOffset = Math.atan2(bases[0][1], bases[0][0])
  const vertexRadius = radius / Math.cos(Math.PI / n)
  const points: [number, number][] = []
  for (let k = 0; k < n; k++) {
    const angle = angleOffset + Math.PI / n + (2 * Math.PI * k) / n
    points.push([cx + vertexRadius * Math.cos(angle), cy + vertexRadius * Math.sin(angle)])
  }
  return points
}
