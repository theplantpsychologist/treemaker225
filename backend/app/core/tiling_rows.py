"""Pure linear-algebra core for the tiling solver: sparse constraint rows over
flap-position variables only (no lengths, no scale), rank-checked incremental
row acceptance, and the minimum-perturbation least-squares solve.

A note on why this uses plain `numpy.linalg` rank/least-squares rather than
"Gaussian elimination over a large prime": the mod-p rank trick is the right
tool when a matrix's entries are free *symbolic* parameters (e.g. a Tutte
matrix for bipartite matching) -- substituting independent random field
elements and relying on Schwartz-Zippel reveals the generic rank with
overwhelming probability. That doesn't apply here: every entry of our matrix
is a *fixed real algebraic number* (a sine/cosine of one of the shape's
snapped angles, e.g. multiples of 22.5 degrees for an octagon), not a free
indeterminate -- irrational values like cos(22.5 degrees) have no meaningful
reduction mod p, and some of the exact dependencies we actually want to catch
(e.g. two antiparallel directions) are real structural relations, not
coincidences a random substitution would even be modeling. `matrix_rank`/
`lstsq` (both SVD-based) are the standard robust tools for a small
real-valued matrix instead, and are already available via numpy with no new
dependency.
"""

from dataclasses import dataclass
from typing import Dict, List, Tuple

import numpy as np

from app.core.constraint_resolution import resolve_leaf_constraint
from app.schemas.constraints import Constraints, LeafConstraint, SymmetryMode

AXIS_X = "x"
AXIS_Y = "y"


@dataclass
class Row:
    """One linear equation `sum(coeff * x[leaf, axis]) = b` over flap-position
    variables. `coeffs` keys are `(leaf_id, axis)` with `axis` in {"x", "y"}."""

    coeffs: Dict[Tuple[str, str], float]
    b: float = 0.0


def _dense_row(row: Row, pos_col: Dict[str, int], n_cols: int) -> np.ndarray:
    vec = np.zeros(n_cols)
    for (leaf_id, axis), coeff in row.coeffs.items():
        col = pos_col[leaf_id] + (0 if axis == AXIS_X else 1)
        vec[col] += coeff
    return vec


def rows_to_matrix(rows: List[Row], pos_col: Dict[str, int]) -> Tuple[np.ndarray, np.ndarray]:
    n_cols = 2 * len(pos_col)
    if not rows:
        return np.zeros((0, n_cols)), np.zeros(0)
    a = np.vstack([_dense_row(r, pos_col, n_cols) for r in rows])
    b = np.array([r.b for r in rows])
    return a, b


def try_accept(accepted_rows: List[Row], new_rows: List[Row], pos_col: Dict[str, int]) -> bool:
    """True iff appending `new_rows` to `accepted_rows` increases the
    coefficient matrix's rank by exactly `len(new_rows)` -- i.e. every new row
    is independent of everything already accepted (and of each other).
    Ignores each row's `b` for this check: this can't distinguish "redundant
    and consistent" from "redundant and conflicting," but either way the safe
    move is the same -- don't add the row (see module docstring; the
    overconstrained/infeasible case is deliberately deferred)."""
    if not new_rows:
        return False
    old_a, _ = rows_to_matrix(accepted_rows, pos_col)
    old_rank = int(np.linalg.matrix_rank(old_a)) if accepted_rows else 0
    trial_a, _ = rows_to_matrix(accepted_rows + new_rows, pos_col)
    trial_rank = int(np.linalg.matrix_rank(trial_a))
    return trial_rank == old_rank + len(new_rows)


def solve_min_perturbation(rows: List[Row], pos_col: Dict[str, int], x0: np.ndarray) -> np.ndarray:
    """min ||x - x0||^2 s.t. A x = b. By construction of the caller's
    rank-checked accept loop (`try_accept`), A always has full row rank, so
    this is always exactly solvable; `np.linalg.lstsq` returns the
    minimum-norm solution for `A @ delta = b - A @ x0` directly, which is
    exactly the minimum-perturbation correction to x0."""
    a, b = rows_to_matrix(rows, pos_col)
    if a.shape[0] == 0:
        return x0.copy()
    delta, _, _, _ = np.linalg.lstsq(a, b - a @ x0, rcond=None)
    return x0 + delta


def _fixed_point_rows(leaf_id: str, point: Tuple[float, float]) -> List[Row]:
    px, py = point
    return [Row({(leaf_id, AXIS_X): 1.0}, px), Row({(leaf_id, AXIS_Y): 1.0}, py)]


def leaf_own_rows(leaf_id: str, constraint: LeafConstraint, mode: SymmetryMode) -> List[Row]:
    """Rows expressing this leaf's own constraint slots -- locked, boundary,
    and symmetry-alone -- NOT including pair-relation rows to its partner
    (see `pair_rows`). A pair leaf's own boundary/locked slot, if any, is
    still handled here independently: pair boundary-pin mirroring already
    keeps both sides' stored constraints mutually consistent upstream (Phase
    4 M35), so there's nothing pair-specific to do for a leaf's own slots."""
    res = resolve_leaf_constraint(mode, constraint)
    if not res.feasible:
        raise ValueError(f"leaf {leaf_id} has an infeasible symmetry/boundary combination")
    if res.point is not None:
        return _fixed_point_rows(leaf_id, res.point)

    # Not fully fixed by locked/corner/edge+symmetry-collapse -- check the two
    # partial (1-row, 1-remaining-DOF) cases `resolve_leaf_constraint`
    # deliberately leaves unresolved.
    if constraint.symmetry.kind == "pin_symmetry":
        if mode == SymmetryMode.BOOK:
            return [Row({(leaf_id, AXIS_X): 1.0}, 0.5)]
        if mode == SymmetryMode.DIAGONAL:
            return [Row({(leaf_id, AXIS_X): 1.0, (leaf_id, AXIS_Y): -1.0}, 0.0)]
    if constraint.boundary.kind == "pin_edge":
        edge = constraint.boundary.edge
        if edge in ("left", "right"):
            return [Row({(leaf_id, AXIS_X): 1.0}, 0.0 if edge == "left" else 1.0)]
        return [Row({(leaf_id, AXIS_Y): 1.0}, 0.0 if edge == "bottom" else 1.0)]
    return []


def pair_rows(leader_id: str, follower_id: str, mode: SymmetryMode) -> List[Row]:
    """Two rows tying the follower's position to `reflect_across_symmetry` of
    the leader's, in row form -- book mirrors x=0.5 (`x_f + x_l = 1`, y
    unchanged); diagonal mirrors x=y (`x_f = y_l`, `y_f = x_l`)."""
    if mode == SymmetryMode.BOOK:
        return [
            Row({(follower_id, AXIS_X): 1.0, (leader_id, AXIS_X): 1.0}, 1.0),
            Row({(follower_id, AXIS_Y): 1.0, (leader_id, AXIS_Y): -1.0}, 0.0),
        ]
    if mode == SymmetryMode.DIAGONAL:
        return [
            Row({(follower_id, AXIS_X): 1.0, (leader_id, AXIS_Y): -1.0}, 0.0),
            Row({(follower_id, AXIS_Y): 1.0, (leader_id, AXIS_X): -1.0}, 0.0),
        ]
    return []


def build_base_rows(leaf_ids: List[str], constraints: Constraints) -> List[Row]:
    """Every user-specified constraint (locked, boundary, symmetry, pairing)
    as rows -- added unconditionally, since the app already validates
    symmetry/boundary feasibility before letting a user set a contradictory
    combination. Convex-hull auto-pinning is NOT included here (see
    tiling_solve.py) -- unlike these, it's derived rather than user-specified
    and is routed through the rank-checked accept/reject path instead, since
    it can plausibly conflict with what's built here."""
    rows: List[Row] = []
    mode = constraints.symmetry_mode
    seen_pairs = set()
    for leaf_id in leaf_ids:
        constraint = constraints.per_leaf.get(leaf_id)
        if constraint is None:
            continue
        rows.extend(leaf_own_rows(leaf_id, constraint, mode))
        if constraint.symmetry.kind == "pair":
            partner = constraint.symmetry.paired_with
            pair_key = tuple(sorted((leaf_id, partner)))
            if pair_key in seen_pairs:
                continue
            seen_pairs.add(pair_key)
            leader, follower = (leaf_id, partner) if leaf_id < partner else (partner, leaf_id)
            rows.extend(pair_rows(leader, follower, mode))
    return rows
