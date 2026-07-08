from typing import Callable, Optional, Sequence, Tuple

import networkx as nx
import numpy as np
from scipy.optimize import NonlinearConstraint, minimize

from app.core.tree import find_distance
from app.core.variable_plan import VariablePlan

# L-BFGS-B is deliberately NOT a selectable solver method: it only supports
# bound constraints, with no mechanism for the O(n^2) pairwise nonlinear
# inequality constraints this problem structurally requires. Offering it
# would mean reformulating those constraints as a penalty term folded into
# the objective -- a different formulation, not a solver swap -- so it's
# left out of SolverMethod (schemas/hyperparams.py) entirely.


def smooth_max(values: Sequence[float], alpha: float) -> float:
    """Numerically stable smooth approximation of max(values)."""
    values_arr = np.array(values)
    peak = np.max(values_arr)
    return float(peak + np.log(np.sum(np.exp(alpha * (values_arr - peak)))) / alpha)


def _pair_distances(plan: VariablePlan, tree: nx.DiGraph):
    leaf_ids = plan.leaf_ids
    return [
        (leaf_ids[i], leaf_ids[j], find_distance(tree, leaf_ids[i], leaf_ids[j]))
        for i in range(len(leaf_ids))
        for j in range(i + 1, len(leaf_ids))
    ]


def _memoized_decode(plan: VariablePlan) -> Callable[[np.ndarray], Tuple[dict, float]]:
    """Wraps `plan.decode` with a size-1 cache keyed on the trial vector's
    bytes. scipy evaluates every one of the O(n^2) pairwise constraints
    back-to-back for the SAME trial point before perturbing to the next one,
    so without this, each restart iteration pays an O(n) decode() cost once
    per constraint (O(n^3) total) instead of once per trial point (O(n))."""
    cache: dict = {}

    def decode(x: np.ndarray):
        key = x.tobytes()
        if key not in cache:
            cache.clear()
            cache[key] = plan.decode(x)
        return cache[key]

    return decode


def _run_restart(
    plan: VariablePlan,
    tree: nx.DiGraph,
    x0: np.ndarray,
    residual: Callable[[float, float, float, float, float, float], float],
    method: str = "slsqp",
    tol: Optional[float] = None,
    max_iter: Optional[int] = None,
) -> Tuple[np.ndarray, float, bool]:
    """Shared restart driver for both circle- and polygon-mode packing:
    maximizes scale subject to `residual(ax, ay, bx, by, scale, dist) >= 0`
    for every leaf pair. `residual` is the only thing that differs between
    the two modes (raw Euclidean distance vs. smooth-max separating-axis
    distance)."""

    def objective(x: np.ndarray) -> float:
        return -x[-1]

    decode = _memoized_decode(plan)
    pairs = _pair_distances(plan, tree)
    options = {"maxiter": max_iter} if max_iter is not None else None

    if method == "trust-constr":
        # trust-constr needs one vector-valued NonlinearConstraint rather
        # than N separate scalar dict-constraints.
        def combined(x: np.ndarray) -> np.ndarray:
            positions, scale = decode(x)
            return np.array([residual(*positions[a], *positions[b], scale, dist) for a, b, dist in pairs])

        constraints = [NonlinearConstraint(combined, lb=0, ub=np.inf)]
    else:
        # SLSQP/COBYLA share the same dict-constraint convention.
        def make_constraint(a: str, b: str, dist: float):
            def fn(x: np.ndarray) -> float:
                positions, scale = decode(x)
                ax, ay = positions[a]
                bx, by = positions[b]
                return residual(ax, ay, bx, by, scale, dist)

            return {"type": "ineq", "fun": fn}

        constraints = [make_constraint(a, b, dist) for a, b, dist in pairs]

    result = minimize(
        objective, x0, bounds=plan.bounds(), constraints=constraints, method=method, tol=tol, options=options
    )
    _, scale = decode(result.x)
    return result.x, float(scale), bool(result.success)


def run_circle_restart(
    plan: VariablePlan,
    tree: nx.DiGraph,
    x0: np.ndarray,
    method: str = "slsqp",
    tol: Optional[float] = None,
    max_iter: Optional[int] = None,
) -> Tuple[np.ndarray, float, bool]:
    """Single-restart circle-packing solve: maximize scale such that every pair
    of leaf centers is at least scale * find_distance(a, b) apart."""

    def residual(ax: float, ay: float, bx: float, by: float, scale: float, dist: float) -> float:
        return ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5 - scale * dist

    return _run_restart(plan, tree, x0, residual, method, tol, max_iter)


def run_polygon_restart(
    plan: VariablePlan,
    tree: nx.DiGraph,
    x0: np.ndarray,
    alpha: float,
    bases: Sequence[Tuple[float, float]],
    method: str = "slsqp",
    tol: Optional[float] = None,
    max_iter: Optional[int] = None,
) -> Tuple[np.ndarray, float, bool]:
    """Single-restart polygon-packing solve: same objective as circle mode, but
    the pairwise separation is the smooth-max separating-axis distance over the
    given shape's face-normal directions instead of raw Euclidean distance."""

    def residual(ax: float, ay: float, bx: float, by: float, scale: float, dist: float) -> float:
        dx, dy = ax - bx, ay - by
        projections = [dx * bx_ + dy * by_ for bx_, by_ in bases]
        return smooth_max(projections, alpha) - scale * dist

    return _run_restart(plan, tree, x0, residual, method, tol, max_iter)
