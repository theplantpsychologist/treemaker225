import math
from dataclasses import dataclass
from typing import Dict, List, Tuple

import networkx as nx
import numpy as np
from scipy.optimize import lsq_linear

from app.core.active_paths import ActivePathEdge, path_edge_ids

# Length columns get this as a floor instead of 0 -- a flap/river can shrink
# arbitrarily close to nothing but never collapse to (or past) exactly zero.
MIN_LENGTH = 1e-4

# How much more heavily the constraint rows are weighted than the plain
# "stay close to x0" displacement rows in the combined least-squares system
# `solve_snap` builds -- see its docstring for why this is the mechanism that
# makes an equality constraint (soft, in principle) satisfied almost exactly
# in practice while still keeping the whole thing a single ordinary bounded
# least-squares solve.
EQUALITY_WEIGHT = 1e4


@dataclass
class VariableIndex:
    """Column layout for the snap solve's variable vector x: every leaf's
    (x, y) position first, then every non-root node's tree-edge length
    (covering both leaf edges -- flap radii -- and internal edges -- river
    widths). Kept as its own small object (rather than inlining column
    arithmetic at each call site) so every constraint-builder below, and any
    future one, addresses variables by id instead of by memorized offset."""

    leaf_ids: List[str]
    length_ids: List[str]
    pos_col: Dict[str, int]
    length_col: Dict[str, int]
    n_cols: int

    @classmethod
    def build(cls, leaf_ids: List[str], length_ids: List[str]) -> "VariableIndex":
        pos_col = {leaf_id: 2 * i for i, leaf_id in enumerate(leaf_ids)}
        base = 2 * len(leaf_ids)
        length_col = {node_id: base + i for i, node_id in enumerate(length_ids)}
        return cls(leaf_ids, length_ids, pos_col, length_col, base + len(length_ids))


def build_angle_constraints(
    active_paths: List[ActivePathEdge], index: VariableIndex
) -> Tuple[np.ndarray, np.ndarray]:
    """One row per active path, enforcing (v_b - v_a) is parallel to the
    path's target snapped direction via `n_hat . (v_b - v_a) = 0`, where
    `n_hat` is perpendicular to that direction (so being perpendicular to
    n_hat is the same thing as being parallel to the direction itself,
    turning an angle constraint into a single linear dot-product equation
    instead of a nonlinear atan2 one). Every row is zero in every length
    column -- this matrix is meaningful entirely on its own (e.g. for a
    future null-space degrees-of-freedom extraction) independent of
    whichever other constraint blocks it ends up stacked with below."""
    rows = np.zeros((len(active_paths), index.n_cols))
    b = np.zeros(len(active_paths))
    for r, p in enumerate(active_paths):
        n_x, n_y = -math.sin(p.angle), math.cos(p.angle)
        ax, ay = index.pos_col[p.a], index.pos_col[p.a] + 1
        bx, by = index.pos_col[p.b], index.pos_col[p.b] + 1
        rows[r, bx] += n_x
        rows[r, ax] -= n_x
        rows[r, by] += n_y
        rows[r, ay] -= n_y
    return rows, b


def build_length_constraints(
    active_paths: List[ActivePathEdge],
    index: VariableIndex,
    tree: nx.DiGraph,
    scale: float,
) -> Tuple[np.ndarray, np.ndarray]:
    """One row per active path, enforcing that the (now angle-fixed)
    distance between its two flaps equals scale times the sum of tree-edge
    lengths along the path between them. Since the angle constraint above
    already pins the direction, "distance along the path" is just the dot
    product of (v_b - v_a) against that fixed direction -- no Euclidean
    norm (and its squared terms) needed."""
    rows = np.zeros((len(active_paths), index.n_cols))
    b = np.zeros(len(active_paths))
    for r, p in enumerate(active_paths):
        d_x, d_y = math.cos(p.angle), math.sin(p.angle)
        ax, ay = index.pos_col[p.a], index.pos_col[p.a] + 1
        bx, by = index.pos_col[p.b], index.pos_col[p.b] + 1
        rows[r, bx] += d_x
        rows[r, ax] -= d_x
        rows[r, by] += d_y
        rows[r, ay] -= d_y
        for edge_id in path_edge_ids(tree, p.a, p.b):
            rows[r, index.length_col[edge_id]] -= scale
    return rows, b


def build_anchor_constraints(
    leaf_ids: List[str], positions: Dict[str, Tuple[float, float]], index: VariableIndex
) -> Tuple[np.ndarray, np.ndarray]:
    """Pins whichever leaf currently sits at the min/max x and min/max y to
    that exact paper boundary (0 or 1). Without this, the angle-only
    constraints leave the whole configuration's overall translation
    unanchored -- any rigid shift along the constrained directions satisfies
    them equally well -- so the least-squares solve could drift the
    packing away from actually using the full sheet instead of just
    snapping angles in place."""
    if len(leaf_ids) == 0:
        return np.zeros((0, index.n_cols)), np.zeros(0)
    xs = {leaf_id: positions[leaf_id][0] for leaf_id in leaf_ids}
    ys = {leaf_id: positions[leaf_id][1] for leaf_id in leaf_ids}
    targets = [
        (max(xs, key=xs.get), 0, 1.0),
        (min(xs, key=xs.get), 0, 0.0),
        (max(ys, key=ys.get), 1, 1.0),
        (min(ys, key=ys.get), 1, 0.0),
    ]
    rows = np.zeros((len(targets), index.n_cols))
    b = np.zeros(len(targets))
    for r, (leaf_id, axis_offset, value) in enumerate(targets):
        rows[r, index.pos_col[leaf_id] + axis_offset] = 1.0
        b[r] = value
    return rows, b


def solve_snap(x0: np.ndarray, a: np.ndarray, b: np.ndarray, lower: np.ndarray, upper: np.ndarray) -> np.ndarray:
    """Finds x minimizing ||x - x0||^2 subject to (as close as possible to)
    `a @ x = b`, exactly respecting `lower <= x <= upper`.

    This is an equality-constrained least-squares problem, which normally
    has a closed form (project x0 onto the affine subspace a @ x = b via a
    pseudoinverse) -- but that closed form has no way to also respect box
    bounds. Instead, the equality constraint is folded into the SAME
    objective as a heavily up-weighted set of rows (stacked below the
    identity "stay close to x0" rows), turning the whole problem into one
    ordinary bounded least-squares solve via `scipy.optimize.lsq_linear`,
    which handles the box bounds exactly. With EQUALITY_WEIGHT this large,
    the constraint residual comes out negligible in practice (far below any
    rendering precision) whenever the bounds don't force a tradeoff -- and
    when they do, the bounds always win exactly, which is the correct
    priority (a slightly-off angle is fine; a negative length is not).

    This system can never come back "infeasible": x0 itself always lies
    inside `[lower, upper]` (every input position/length is already valid
    coming in), and a nonempty box together with a convex objective always
    has a minimizer. What can happen instead is that an over-determined or
    mutually contradictory set of angle/length/anchor constraints doesn't
    get satisfied exactly -- lsq_linear just spreads the leftover residual
    across them by ordinary least squares, same as any other overdetermined
    linear system.
    """
    n = x0.shape[0]
    stacked_a = np.vstack([np.eye(n), EQUALITY_WEIGHT * a])
    stacked_b = np.concatenate([x0, EQUALITY_WEIGHT * b])
    result = lsq_linear(stacked_a, stacked_b, bounds=(lower, upper))
    return result.x
