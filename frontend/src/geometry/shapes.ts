export type ShapeKind = 'circle' | 'square' | 'hexagon' | 'octagon' | 'dodecagon'

export const SHAPE_OPTIONS: { value: ShapeKind; label: string }[] = [
  { value: 'circle', label: 'Circle' },
  { value: 'square', label: 'Square' },
  { value: 'hexagon', label: 'Hexagon' },
  { value: 'octagon', label: 'Octagon' },
  { value: 'dodecagon', label: 'Dodecagon' },
]

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

export const SHAPE_BASES: Record<Exclude<ShapeKind, 'circle'>, [number, number][]> = {
  square: regularNgonBases(4),
  // A horizontal top/bottom edge means a vertical face normal, hence the 90-degree offset.
  hexagon: regularNgonBases(6, Math.PI / 2),
  octagon: OCT_BASES,
  dodecagon: regularNgonBases(12),
}

/** The separating-axis bases for `shape`, or null for 'circle' — the
 * degenerate case with no discrete bases (plain Euclidean distance). */
export function getBases(shape: ShapeKind): [number, number][] | null {
  if (shape === 'circle') return null
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
 * circle) equals `radius`. */
export function buildShapePoints(shape: ShapeKind, cx: number, cy: number, radius: number): [number, number][] {
  if (shape === 'circle') {
    const points: [number, number][] = []
    for (let k = 0; k < CIRCLE_SEGMENTS; k++) {
      const angle = (2 * Math.PI * k) / CIRCLE_SEGMENTS
      points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)])
    }
    return points
  }
  const bases = SHAPE_BASES[shape]
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
