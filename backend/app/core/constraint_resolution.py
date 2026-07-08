"""Feasibility/collapse rules for combining a leaf's independent symmetry
and boundary constraint slots. This is a line-for-line port of
`frontend/src/geometry/constraintResolution.ts` — keep the two in sync."""

from typing import List, NamedTuple, Optional, Tuple

from app.schemas.constraints import Constraints, LeafConstraint, SymmetryMode

Point = Tuple[float, float]


class Resolution(NamedTuple):
    """`feasible=False` means this symmetry+boundary combination is a
    straight contradiction (e.g. book symmetry pins x=0.5, but a left/right
    edge pin pins x=0/1) — callers must reject whatever action would
    produce it. `point` is non-None only when the leaf's OWN position is
    fully determined by its constraints alone."""

    feasible: bool
    point: Optional[Point]


_FEASIBLE_FREE = Resolution(True, None)
_INFEASIBLE = Resolution(False, None)


def corner_position(corner: str) -> Point:
    """The unit square is math-convention y-up (y=0 at the bottom, y=1 at
    the top) — the frontend applies a single compensating y-flip at the
    final screen-pixel conversion (see `geometry/edgePin.ts`)."""
    return {
        "top_left": (0.0, 1.0),
        "top_right": (1.0, 1.0),
        "bottom_left": (0.0, 0.0),
        "bottom_right": (1.0, 0.0),
    }[corner]


def edge_position(edge: str, s: float) -> Point:
    if edge == "left":
        return (0.0, s)
    if edge == "right":
        return (1.0, s)
    if edge == "top":
        return (s, 1.0)
    if edge == "bottom":
        return (s, 0.0)
    raise ValueError(f"unknown edge {edge}")


def reflect_across_symmetry(p: Point, mode: SymmetryMode) -> Point:
    if mode == SymmetryMode.BOOK:
        return (1.0 - p[0], p[1])
    if mode == SymmetryMode.DIAGONAL:
        return (p[1], p[0])
    return p


def mirror_edge(mode: SymmetryMode, edge: str) -> str:
    """Line-for-line port of `mirrorEdge` in geometry/symmetry.ts."""
    if mode == SymmetryMode.BOOK:
        if edge == "left":
            return "right"
        if edge == "right":
            return "left"
        return edge
    if mode == SymmetryMode.DIAGONAL:
        return {"top": "right", "right": "top", "bottom": "left", "left": "bottom"}[edge]
    return edge


def mirror_corner(mode: SymmetryMode, corner: str) -> str:
    """Line-for-line port of `mirrorCorner` in geometry/symmetry.ts."""
    if mode == SymmetryMode.BOOK:
        return {
            "top_left": "top_right",
            "top_right": "top_left",
            "bottom_left": "bottom_right",
            "bottom_right": "bottom_left",
        }[corner]
    if mode == SymmetryMode.DIAGONAL:
        if corner == "top_left":
            return "bottom_right"
        if corner == "bottom_right":
            return "top_left"
        return corner
    return corner


def _diagonal_corner(edge: str) -> Point:
    """A pin_edge + diagonal pin_symmetry combo collapses to wherever that
    edge meets the line x=y — see `diagonalCorner` in
    constraintResolution.ts for the y-up convention this assumes."""
    return (1.0, 1.0) if edge in ("top", "right") else (0.0, 0.0)


def _on_symmetry_line(mode: SymmetryMode, p: Point) -> bool:
    if mode == SymmetryMode.BOOK:
        return abs(p[0] - 0.5) < 1e-9
    if mode == SymmetryMode.DIAGONAL:
        return abs(p[0] - p[1]) < 1e-9
    return True


def _resolve_symmetry_boundary(mode: SymmetryMode, constraint: LeafConstraint) -> Resolution:
    """See `resolveLeafConstraint` in constraintResolution.ts for the full
    derivation of each case."""
    pinned_to_symmetry = constraint.symmetry.kind == "pin_symmetry"
    boundary = constraint.boundary

    if boundary.kind == "pin_corner":
        p = corner_position(boundary.corner)
        if pinned_to_symmetry and not _on_symmetry_line(mode, p):
            return _INFEASIBLE
        return Resolution(True, p)

    if boundary.kind == "pin_edge":
        if not pinned_to_symmetry or mode == SymmetryMode.NONE:
            return _FEASIBLE_FREE
        if mode == SymmetryMode.BOOK:
            if boundary.edge in ("left", "right"):
                return _INFEASIBLE
            return Resolution(True, (0.5, 0.0 if boundary.edge == "top" else 1.0))
        return Resolution(True, _diagonal_corner(boundary.edge))

    return _FEASIBLE_FREE


def resolve_leaf_constraint(mode: SymmetryMode, constraint: LeafConstraint) -> Resolution:
    """A `locked` slot overrides symmetry+boundary resolution entirely — it
    freezes whatever DOF they leave free at a snapshot value, so a locked
    leaf is always fully fixed regardless of its other two slots."""
    if constraint.locked.kind == "locked":
        return Resolution(True, (constraint.locked.point.x, constraint.locked.point.y))
    return _resolve_symmetry_boundary(mode, constraint)


def is_fully_fixed_by_symmetry_boundary(mode: SymmetryMode, constraint: LeafConstraint) -> bool:
    """Whether the leaf is already fully fixed by symmetry+boundary alone,
    ignoring any existing lock — used to decide whether locking it would
    freeze any actual remaining freedom."""
    res = _resolve_symmetry_boundary(mode, constraint)
    return res.feasible and res.point is not None


class ResolvedPointEntry(NamedTuple):
    leaf_id: str
    point: Point
    derived: bool


def collect_resolved_points(leaf_ids: List[str], constraints: Constraints) -> List[ResolvedPointEntry]:
    """Every leaf whose position is fully determined — by its own
    constraints, or by a paired partner's — for pre-commit collision
    checks. Mirrors `collectResolvedPoints` in constraintResolution.ts."""
    out: List[ResolvedPointEntry] = []
    for leaf_id in leaf_ids:
        c = constraints.per_leaf.get(leaf_id)
        if c is None:
            continue
        res = resolve_leaf_constraint(constraints.symmetry_mode, c)
        if not res.feasible or res.point is None:
            continue
        out.append(ResolvedPointEntry(leaf_id, res.point, False))
        if c.symmetry.kind == "pair":
            out.append(
                ResolvedPointEntry(
                    c.symmetry.paired_with,
                    reflect_across_symmetry(res.point, constraints.symmetry_mode),
                    True,
                )
            )
    return out


def _points_equal(a: Point, b: Point) -> bool:
    return abs(a[0] - b[0]) < 1e-9 and abs(a[1] - b[1]) < 1e-9


def find_any_collision(
    entries: List[ResolvedPointEntry],
) -> Optional[Tuple[ResolvedPointEntry, ResolvedPointEntry]]:
    for i in range(len(entries)):
        for j in range(i + 1, len(entries)):
            if entries[i].leaf_id != entries[j].leaf_id and _points_equal(entries[i].point, entries[j].point):
                return entries[i], entries[j]
    return None
