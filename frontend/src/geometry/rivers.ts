import { difference, inflatePaths, union, FillRule, JoinType, EndType } from 'clipper2-ts'
import { buildShapePoints } from './shapes'
import type { ShapeKind } from './shapes'
import type { TreeState } from '../types/tree'
import type { SymmetryMode } from '../types/constraints'

interface Pt {
  x: number
  y: number
}

type Rings = Pt[][]

export interface RiverBand {
  nodeId: string
  rings: Rings
}

/** Clipper2's robust arithmetic wants more numeric range than our [0,1]
 * packing space provides directly — scale up before calling in, back down
 * (via ringsToPathD's own scale factor) when rendering. */
const CLIPPER_SCALE = 100000

function toClipperRing(points: [number, number][]): Pt[] {
  return points.map(([x, y]) => ({ x: x * CLIPPER_SCALE, y: y * CLIPPER_SCALE }))
}

function fromClipperRings(rings: Rings): Rings {
  return rings.map((ring) => ring.map((p) => ({ x: p.x / CLIPPER_SCALE, y: p.y / CLIPPER_SCALE })))
}

interface NodeResult {
  /** This node's own outer boundary, in clipper-scaled coordinates — what
   * its parent unions with its siblings' footprints. */
  footprint: Rings
  bands: RiverBand[]
}

function computeNode(
  tree: TreeState,
  positions: Record<string, { x: number; y: number }>,
  scale: number,
  shape: ShapeKind,
  nodeId: string,
  symmetryMode: SymmetryMode,
  extraRotation: boolean,
): NodeResult | null {
  const node = tree.nodes[nodeId]
  const pos = positions[nodeId]
  if (!node || !pos) return null

  if (node.children.length === 0) {
    if (node.length == null) return null
    const radius = scale * node.length
    const shapePoints = buildShapePoints(shape, pos.x, pos.y, radius, symmetryMode, extraRotation)
    return { footprint: [toClipperRing(shapePoints)], bands: [] }
  }

  const childResults = node.children
    .map((childId) => computeNode(tree, positions, scale, shape, childId, symmetryMode, extraRotation))
    .filter((r): r is NodeResult => r !== null)
  if (childResults.length === 0) return null

  const childFootprints = childResults.flatMap((r) => r.footprint)
  const innerUnion = union(childFootprints, [], FillRule.NonZero)
  const bands = childResults.flatMap((r) => r.bands)

  if (node.parentId == null || node.length == null) {
    // Root has no edge of its own (length is always null) — no band, no
    // offset; its "footprint" is unused since nothing sits above it.
    return { footprint: innerUnion, bands }
  }

  const width = scale * node.length
  // Round joins are only correct for circles — every polygon shape gets
  // mitered (straight-edge) joins instead, the practical stand-in for a
  // true straight-skeleton sweep (exact for convex geometry; Clipper's
  // internal miter limit handles reflex corners gracefully).
  const joinType = shape === 'circle' ? JoinType.Round : JoinType.Miter
  const outer = inflatePaths(innerUnion, width * CLIPPER_SCALE, joinType, EndType.Polygon)
  // The inner boundary is the OUTER shape offset back inward by the same
  // width — not the original children union — so the band is exactly
  // `width` thick everywhere and a tight gap between two children gets
  // swallowed by the inward offset instead of rendering as a sliver.
  const innerBoundary = inflatePaths(outer, -width * CLIPPER_SCALE, joinType, EndType.Polygon)
  const band = difference(outer, innerBoundary, FillRule.NonZero)
  return { footprint: outer, bands: [...bands, { nodeId, rings: fromClipperRings(band) }] }
}

/** Recursively unions each internal node's children's footprints, offsets
 * outward by that node's own width, and subtracts the union back out to
 * leave the visible river band — the shape may legitimately be disconnected
 * or holed when children are far apart. */
export function computeRiverBands(
  tree: TreeState,
  positions: Record<string, { x: number; y: number }>,
  scale: number,
  shape: ShapeKind,
  symmetryMode: SymmetryMode = 'none',
  extraRotation = false,
): RiverBand[] {
  if (!tree.rootId) return []
  return computeNode(tree, positions, scale, shape, tree.rootId, symmetryMode, extraRotation)?.bands ?? []
}

/** Renders a (possibly multi-ring, possibly disconnected) river band as one
 * SVG path — `fill-rule="evenodd"` on the consumer handles nested holes
 * regardless of winding direction. Flips y (the unit square is y-up
 * internally, see `geometry/edgePin.ts`) so it renders right-side up. */
export function ringsToPathD(rings: Rings, viewScale: number): string {
  return rings
    .map(
      (ring) =>
        ring.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x * viewScale},${(1 - p.y) * viewScale}`).join(' ') + ' Z',
    )
    .join(' ')
}
