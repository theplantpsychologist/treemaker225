export const OCT_BASES: [number, number][] = [
  [1, 0],
  [1 / Math.SQRT2, 1 / Math.SQRT2],
  [0, 1],
  [-1 / Math.SQRT2, 1 / Math.SQRT2],
  [-1, 0],
  [-1 / Math.SQRT2, -1 / Math.SQRT2],
  [0, -1],
  [1 / Math.SQRT2, -1 / Math.SQRT2],
]

/** Vertices of an octagon centered at (cx, cy) whose apothem (center-to-edge
 * distance along each OCT_BASES direction) equals `radius`. */
export function buildOctagonPoints(cx: number, cy: number, radius: number): [number, number][] {
  const n = 8
  const vertexRadius = radius / Math.cos(Math.PI / n)
  const points: [number, number][] = []
  for (let k = 0; k < n; k++) {
    const angle = (2 * Math.PI * k) / n + Math.PI / n + Math.PI / 2
    points.push([cx + vertexRadius * Math.cos(angle), cy + vertexRadius * Math.sin(angle)])
  }
  return points
}
