from typing import Sequence, Tuple

import networkx as nx
import numpy as np
from scipy.optimize import minimize

from app.core.tree import find_distance
from app.core.variable_plan import VariablePlan


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


def run_circle_restart(
    plan: VariablePlan, tree: nx.DiGraph, x0: np.ndarray
) -> Tuple[np.ndarray, float, bool]:
    """Single-restart circle-packing solve: maximize scale such that every pair
    of leaf centers is at least scale * find_distance(a, b) apart."""

    def objective(x: np.ndarray) -> float:
        return -x[-1]

    def make_constraint(a: str, b: str, dist: float):
        def fn(x: np.ndarray) -> float:
            positions, scale = plan.decode(x)
            ax, ay = positions[a]
            bx, by = positions[b]
            return ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5 - scale * dist

        return {"type": "ineq", "fun": fn}

    constraints = [make_constraint(a, b, dist) for a, b, dist in _pair_distances(plan, tree)]
    result = minimize(objective, x0, bounds=plan.bounds(), constraints=constraints, method="SLSQP")
    _, scale = plan.decode(result.x)
    return result.x, float(scale), bool(result.success)


def run_polygon_restart(
    plan: VariablePlan,
    tree: nx.DiGraph,
    x0: np.ndarray,
    alpha: float,
    bases: Sequence[Tuple[float, float]],
) -> Tuple[np.ndarray, float, bool]:
    """Single-restart polygon-packing solve: same objective as circle mode, but
    the pairwise separation is the smooth-max separating-axis distance over the
    given shape's face-normal directions instead of raw Euclidean distance."""

    def objective(x: np.ndarray) -> float:
        return -x[-1]

    def make_constraint(a: str, b: str, dist: float):
        def fn(x: np.ndarray) -> float:
            positions, scale = plan.decode(x)
            ax, ay = positions[a]
            bx, by = positions[b]
            dx, dy = ax - bx, ay - by
            projections = [dx * bx_ + dy * by_ for bx_, by_ in bases]
            return smooth_max(projections, alpha) - scale * dist

        return {"type": "ineq", "fun": fn}

    constraints = [make_constraint(a, b, dist) for a, b, dist in _pair_distances(plan, tree)]
    result = minimize(objective, x0, bounds=plan.bounds(), constraints=constraints, method="SLSQP")
    _, scale = plan.decode(result.x)
    return result.x, float(scale), bool(result.success)
