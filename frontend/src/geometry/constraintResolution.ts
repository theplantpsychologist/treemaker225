import type { ConstraintsState, EdgeSide, LeafConstraint, SymmetryMode } from '../types/constraints'
import type { TreeState } from '../types/tree'
import { getLeaves } from './treeGeometry'
import { reflect } from './symmetry'
import { cornerPosition } from './edgePin'

export interface Point {
  x: number
  y: number
}

export interface Resolution {
  /** false = this symmetry+boundary combination is a straight contradiction
   * (e.g. book symmetry pins x=0.5, but a left/right edge pin pins x=0/1) —
   * callers must reject the action that would produce it. */
  feasible: boolean
  /** Non-null only when the leaf's OWN position is fully determined by its
   * constraints alone, independent of any free/drag variable — used for
   * both corner-picker greying and cross-leaf collision checks. */
  point: Point | null
}

const FEASIBLE_FREE: Resolution = { feasible: true, point: null }
const INFEASIBLE: Resolution = { feasible: false, point: null }

function diagonalCorner(edge: EdgeSide): Point {
  return edge === 'top' || edge === 'left' ? { x: 0, y: 0 } : { x: 1, y: 1 }
}

function onSymmetryLine(mode: SymmetryMode, p: Point): boolean {
  if (mode === 'book') return Math.abs(p.x - 0.5) < 1e-9
  if (mode === 'diagonal') return Math.abs(p.x - p.y) < 1e-9
  return true
}

/**
 * Resolves what a single leaf's own symmetry+boundary combo implies, given
 * the global symmetry mode:
 * - `pin_corner` is always fully fixed at that corner; combined with
 *   `pin_symmetry`, it additionally requires the corner lie on the symmetry
 *   line (diagonal passes through top_left/bottom_right only; book passes
 *   through none — any book+pin_corner+pin_symmetry combo is infeasible).
 * - `pin_edge` + `pin_symmetry`: book+top/bottom resolves to that edge's
 *   midpoint; book+left/right is a straight contradiction; diagonal+any
 *   edge collapses to top_left (top/left) or bottom_right (bottom/right).
 * - Anything else (a lone edge pin, a lone symmetry pin, `pair`, `none`)
 *   still has at least one free degree of freedom — feasible, unresolved.
 * Does NOT account for `pair` mirroring on its own — see
 * `collectResolvedPoints` for the partner-mirroring behavior.
 */
export function resolveLeafConstraint(mode: SymmetryMode, constraint: LeafConstraint): Resolution {
  const pinnedToSymmetry = constraint.symmetry.kind === 'pin_symmetry'
  const boundary = constraint.boundary

  if (boundary.kind === 'pin_corner') {
    const p = cornerPosition(boundary.corner)
    if (pinnedToSymmetry && !onSymmetryLine(mode, p)) return INFEASIBLE
    return { feasible: true, point: p }
  }

  if (boundary.kind === 'pin_edge') {
    if (!pinnedToSymmetry || mode === 'none') return FEASIBLE_FREE
    if (mode === 'book') {
      if (boundary.edge === 'left' || boundary.edge === 'right') return INFEASIBLE
      return { feasible: true, point: { x: 0.5, y: boundary.edge === 'top' ? 0 : 1 } }
    }
    return { feasible: true, point: diagonalCorner(boundary.edge) }
  }

  return FEASIBLE_FREE
}

export interface ResolvedPointEntry {
  leafId: string
  point: Point
  /** True when this point is the *mirrored* position implied by a paired
   * partner's own pin, not one this leaf declared itself. */
  derived: boolean
}

/**
 * Every leaf whose position is fully determined — by its own constraints,
 * or by a paired partner's — for corner-picker greying and pre-commit
 * collision checks. Infeasible combinations never make it into the
 * constraints state (callers reject those before applying), so this only
 * has to walk feasible ones.
 */
export function collectResolvedPoints(tree: TreeState, constraints: ConstraintsState): ResolvedPointEntry[] {
  const out: ResolvedPointEntry[] = []
  for (const leafId of getLeaves(tree)) {
    const c = constraints.perLeaf[leafId]
    if (!c) continue
    const res = resolveLeafConstraint(constraints.symmetryMode, c)
    if (!res.feasible || !res.point) continue
    out.push({ leafId, point: res.point, derived: false })
    if (c.symmetry.kind === 'pair') {
      out.push({
        leafId: c.symmetry.pairedWith,
        point: reflect(constraints.symmetryMode, res.point),
        derived: true,
      })
    }
  }
  return out
}

function pointsEqual(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9
}

/** The first resolved point (own or pair-derived) belonging to a leaf other
 * than `excludeLeafId` that collides with `point`, or null if none. */
export function findPointCollision(
  entries: ResolvedPointEntry[],
  point: Point,
  excludeLeafId: string,
): ResolvedPointEntry | null {
  return entries.find((e) => e.leafId !== excludeLeafId && pointsEqual(e.point, point)) ?? null
}

/** Convenience check used by both constraint validation and the corner-pin
 * picker's greyed-out state. */
export function isPointOccupied(
  tree: TreeState,
  constraints: ConstraintsState,
  point: Point,
  excludeLeafId: string,
): boolean {
  return findPointCollision(collectResolvedPoints(tree, constraints), point, excludeLeafId) != null
}

/** Any two distinct leaves whose resolved points (own or pair-derived)
 * coincide — used after speculatively building a candidate constraints
 * state to catch collisions a single pre-commit check might miss (e.g. a
 * newly-paired leaf's mirrored point landing on a third leaf's pin). */
export function findAnyCollision(
  entries: ResolvedPointEntry[],
): [ResolvedPointEntry, ResolvedPointEntry] | null {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i].leafId !== entries[j].leafId && pointsEqual(entries[i].point, entries[j].point)) {
        return [entries[i], entries[j]]
      }
    }
  }
  return null
}
