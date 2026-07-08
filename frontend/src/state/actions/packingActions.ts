import type { Point } from '../../geometry/symmetry'
import { reflect, projectOntoLine } from '../../geometry/symmetry'
import { cornerPosition, projectOntoEdge } from '../../geometry/edgePin'
import type { ConstraintsState, LeafConstraint } from '../../types/constraints'
import { NO_LEAF_CONSTRAINT } from '../../types/constraints'

function clamp01(p: Point): Point {
  return { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) }
}

/** Composes both independent constraint slots in the same order the
 * feasibility table in `geometry/constraintResolution.ts` assumes: the
 * symmetry-family projection (if any) applies first, then the
 * boundary-family projection (if any) narrows the result further — e.g. a
 * diagonal `pin_symmetry` + `pin_edge('top')` leaf projects onto the
 * diagonal line first, then onto the top edge, landing exactly on
 * `top_left`. */
export function projectForConstraints(
  constraint: LeafConstraint,
  symmetryMode: ConstraintsState['symmetryMode'],
  raw: Point,
): Point {
  const afterSymmetry = constraint.symmetry.kind === 'pin_symmetry' ? projectOntoLine(symmetryMode, raw) : raw
  switch (constraint.boundary.kind) {
    case 'pin_edge':
      return clamp01(projectOntoEdge(constraint.boundary.edge, afterSymmetry))
    case 'pin_corner':
      return cornerPosition(constraint.boundary.corner)
    default:
      return clamp01(afterSymmetry)
  }
}

/** Moves nodeId to (x, y), respecting its constraint's remaining degrees of
 * freedom, and cascades to its pair partner (if any) via reflection. Always
 * (re)computes the correct projected position, including for pin_corner
 * (fixed regardless of input) — this is also used to instantly snap a flap
 * right after a new constraint is applied, not just during a user drag.
 * Callers must only invoke this with the leaf whose OWN constraint is
 * authoritative (see `usePackingEditorInteraction`'s resolved-position drag
 * block and `state/store.ts`'s pin actions) — calling it for the *other*
 * half of a pair whose partner already has a fixed boundary pin would
 * overwrite that fixed point with a reflection of arbitrary input. */
export function moveFlapPositions(
  positions: Record<string, Point>,
  constraints: ConstraintsState,
  nodeId: string,
  x: number,
  y: number,
): Record<string, Point> {
  const constraint = constraints.perLeaf[nodeId] ?? NO_LEAF_CONSTRAINT
  const projected = projectForConstraints(constraint, constraints.symmetryMode, { x, y })
  const next = { ...positions, [nodeId]: projected }
  if (constraint.symmetry.kind === 'pair') {
    next[constraint.symmetry.pairedWith] = reflect(constraints.symmetryMode, projected)
  }
  return next
}
