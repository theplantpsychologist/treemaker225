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

export const SHAPE_BASES: Record<Exclude<ShapeKind, 'circle' | 'hexagon' | 'square' | 'dodecagon'>, [number, number][]> = {
  octagon: OCT_BASES,
}

/** Square's angle offset is computed on demand, mirroring hexagon's pattern
 * — unlike hexagon (whose diagonal-symmetry 45° is unconditional), square's
 * 45° rotation is purely the manual `extraRotation` toggle; any "default to
 * rotated when diagonal symmetry is active" behavior lives at the call site
 * (`state/store.ts`) as a one-time default, not baked into this function.
 * Cached per offset (only 2 combinations exist) for the same referential-
 * stability reason `hexagonBases` is cached. */
const squareBasesCache = new Map<number, [number, number][]>()
function squareBases(extraRotation: boolean): [number, number][] {
  const offset = extraRotation ? Math.PI / 4 : 0
  let cached = squareBasesCache.get(offset)
  if (!cached) {
    cached = regularNgonBases(4, offset)
    squareBasesCache.set(offset, cached)
  }
  return cached
}

/** Dodecagon's angle offset is computed on demand, mirroring square's
 * pattern — a manual `extraRotation` toggle rotating it 15°; any "default to
 * rotated when diagonal symmetry is active" behavior lives at the call site
 * (`state/store.ts`), not baked into this function. Cached per offset (only
 * 2 combinations exist) for the same referential-stability reason
 * `hexagonBases` is cached. */
const dodecagonBasesCache = new Map<number, [number, number][]>()
function dodecagonBases(extraRotation: boolean): [number, number][] {
  const offset = extraRotation ? Math.PI / 12 : 0
  let cached = dodecagonBasesCache.get(offset)
  if (!cached) {
    cached = regularNgonBases(12, offset)
    dodecagonBasesCache.set(offset, cached)
  }
  return cached
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
 * `symmetryMode` only affects hexagon; `extraRotation` is whichever shape's
 * own rotation toggle is active for the current `shape` (callers compute
 * this — see `hexagonBases`/`squareBases`). */
export function getBases(
  shape: ShapeKind,
  symmetryMode: SymmetryMode = 'none',
  extraRotation = false,
): [number, number][] | null {
  if (shape === 'circle') return null
  if (shape === 'hexagon') return hexagonBases(symmetryMode, extraRotation)
  if (shape === 'square') return squareBases(extraRotation)
  if (shape === 'dodecagon') return dodecagonBases(extraRotation)
  return SHAPE_BASES[shape]
}

/** Picks whichever shape's own rotation-toggle hyperparam applies to
 * `shape` (only hexagon/square/dodecagon have one) — the one three-way
 * dispatch every call site needs, instead of duplicating this ternary. */
export function extraRotationFor(
  shape: ShapeKind,
  hexagonExtraRotation: boolean,
  squareExtraRotation: boolean,
  dodecagonExtraRotation: boolean,
): boolean {
  if (shape === 'hexagon') return hexagonExtraRotation
  if (shape === 'square') return squareExtraRotation
  if (shape === 'dodecagon') return dodecagonExtraRotation
  return false
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
 * hexagon/square (see `hexagonBases`/`squareBases`) — pass the live values
 * so a rendered hexagon/square's orientation always matches what the solver
 * actually used. */
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
