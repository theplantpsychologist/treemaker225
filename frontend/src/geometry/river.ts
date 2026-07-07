/** The 4 corners of a straight band of the given width connecting two points. */
export function riverPolygon(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  width: number,
): [number, number][] {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const len = Math.hypot(dx, dy) || 1e-9
  const nx = -dy / len
  const ny = dx / len
  const hw = width / 2
  return [
    [p1.x + nx * hw, p1.y + ny * hw],
    [p2.x + nx * hw, p2.y + ny * hw],
    [p2.x - nx * hw, p2.y - ny * hw],
    [p1.x - nx * hw, p1.y - ny * hw],
  ]
}
