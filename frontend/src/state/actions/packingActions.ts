import type { Point } from '../../geometry/symmetry'
import { reflect, projectOntoLine } from '../../geometry/symmetry'
import { cornerPosition, projectOntoEdge } from '../../geometry/edgePin'
import type { ConstraintsState, FlapConstraint } from '../../types/constraints'

export function projectForConstraint(
  constraint: FlapConstraint,
  symmetryMode: ConstraintsState['symmetryMode'],
  raw: Point,
): Point {
  switch (constraint.kind) {
    case 'pin_symmetry':
      return projectOntoLine(symmetryMode, raw)
    case 'pin_edge':
      return projectOntoEdge(constraint.edge, raw)
    case 'pin_corner':
      return cornerPosition(constraint.corner)
    default:
      return raw
  }
}

/** Moves nodeId to (x, y), respecting its constraint's remaining degrees of
 * freedom, and cascades to its pair partner (if any) via reflection. Always
 * (re)computes the correct projected position, including for pin_corner
 * (fixed regardless of input) — this is also used to instantly snap a flap
 * right after a new constraint is applied, not just during a user drag.
 * Blocking interactive dragging for pin_corner is the interaction layer's
 * job (see usePackingEditorInteraction), not this function's. */
export function moveFlapPositions(
  positions: Record<string, Point>,
  constraints: ConstraintsState,
  nodeId: string,
  x: number,
  y: number,
): Record<string, Point> {
  const constraint = constraints.perLeaf[nodeId] ?? { kind: 'none' }
  const projected = projectForConstraint(constraint, constraints.symmetryMode, { x, y })
  const next = { ...positions, [nodeId]: projected }
  if (constraint.kind === 'pair') {
    next[constraint.pairedWith] = reflect(constraints.symmetryMode, projected)
  }
  return next
}
