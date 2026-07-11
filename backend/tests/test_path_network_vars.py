import math

import numpy as np

from app.core.path_network import compute_path_network
from app.core.path_network_vars import (
    PathNetworkVariableIndex,
    build_constraints,
    build_initial_guess,
    build_objective,
)
from app.core.tree import build_tree, get_leaves
from app.core.variable_plan import VariablePlan
from app.schemas.constraints import Constraints, SymmetryMode
from app.schemas.tree import NodeIn, TreeIn


def _triplet_tree_and_positions():
    """Three leaves off one root, positioned so flap A has two indirect
    candidates (to B and to C) that commit to the SAME octagon direction at
    A -- the "shared direction forms a triplet" mechanism from
    path_network.py's module docstring, giving a genuine (non-doomed)
    degree-3 point group to exercise."""
    tree = build_tree(
        TreeIn(
            root_id="root",
            nodes=[
                NodeIn(id="root", parent_id=None, length=None),
                NodeIn(id="a", parent_id="root", length=1.0),
                NodeIn(id="b", parent_id="root", length=1.0),
                NodeIn(id="c", parent_id="root", length=1.0),
            ],
        )
    )
    scale = 0.3
    a = (0.1, 0.1)
    angle_b = math.radians(15.0)
    angle_c = math.radians(30.0)
    b = (a[0] + scale * 2.0 * math.cos(angle_b), a[1] + scale * 2.0 * math.sin(angle_b))
    c = (a[0] + scale * 2.0 * math.cos(angle_c), a[1] + scale * 2.0 * math.sin(angle_c))
    return tree, {"a": a, "b": b, "c": c}, scale


def _build_all(count_weight=1.0, c1=0.01, c2=0.001, c3=0.001, annealing_weight=0.1):
    tree, positions, scale = _triplet_tree_and_positions()
    leaf_ids = get_leaves(tree)
    constraints = Constraints()
    plan = VariablePlan(leaf_ids, constraints)
    length_ids = [n for n in tree.nodes if n != "root"]
    initial_lengths = {e: tree.edges[next(tree.predecessors(e)), e]["length"] for e in length_ids}

    network = compute_path_network(
        tree, leaf_ids, positions, scale=scale, shape="octagon", symmetry_mode="none",
        extra_rotation=False, length_tolerance=0.05, angle_tolerance_degrees=10.0,
    )
    assert network is not None

    index = PathNetworkVariableIndex.build(plan, length_ids, network)
    x0 = build_initial_guess(index, network, positions, initial_lengths)

    objective = build_objective(
        index, positions, initial_lengths, count_weight, c1, c2, c3, SymmetryMode.NONE, annealing_weight
    )
    constraints_list = build_constraints(index, network, tree, scale=scale, alpha=100.0, bases=None, equal_pairs={})
    return index, network, x0, objective, constraints_list, initial_lengths


def test_variable_index_bounds_match_column_count():
    index, network, x0, objective, constraints_list, initial_lengths = _build_all()
    bounds = index.bounds(initial_lengths, growth_cap=3.0)
    assert len(bounds) == index.n_cols
    assert x0.shape[0] == index.n_cols
    for value, (lo, hi) in zip(x0, bounds):
        if lo is not None:
            assert value >= lo - 1e-9
        if hi is not None:
            assert value <= hi + 1e-9


def test_objective_gradient_matches_finite_difference():
    index, network, x0, objective, constraints_list, _initial_lengths = _build_all()
    total0, grad = objective(x0)
    assert np.isfinite(total0)
    assert np.all(np.isfinite(grad))

    rng = np.random.default_rng(0)
    # Perturb x0 off its (somewhat degenerate) initial guess a bit so the
    # gradient check isn't accidentally sitting at a trivial stationary
    # point (e.g. boolean columns exactly at 0.5, where several terms'
    # curvature is locally symmetric).
    x = x0 + rng.normal(scale=0.01, size=x0.shape[0])
    total, grad = objective(x)

    eps = 1e-6
    rng_cols = rng.choice(x.shape[0], size=min(8, x.shape[0]), replace=False)
    for col in rng_cols:
        plus = x.copy(); plus[col] += eps
        minus = x.copy(); minus[col] -= eps
        f_plus, _ = objective(plus)
        f_minus, _ = objective(minus)
        finite_diff = (f_plus - f_minus) / (2 * eps)
        assert abs(grad[col] - finite_diff) < 1e-3 * max(1.0, abs(finite_diff)), (
            f"col {col}: analytical={grad[col]!r} finite_diff={finite_diff!r}"
        )


def test_objective_rewards_selecting_more_paths_and_vertices():
    # With every other term zeroed out, the primary count-maximization term
    # alone should prefer more direct/leg/point-active booleans turned on --
    # i.e. a lower (more negative) objective value.
    index, network, x0, objective, constraints_list, _initial_lengths = _build_all(
        count_weight=1.0, c1=0.0, c2=0.0, c3=0.0, annealing_weight=0.0
    )
    assert len(index.point_ids) > 0

    x_none = x0.copy()
    for col in index.all_boolean_cols():
        x_none[col] = 0.0
    x_some = x0.copy()
    for col in index.direct_col.values():
        x_some[col] = 1.0
    for col in index.leg_col.values():
        x_some[col] = 1.0
    for col in index.point_bool_col.values():
        x_some[col] = 1.0

    total_none, _ = objective(x_none)
    total_some, _ = objective(x_some)
    assert total_some < total_none


def test_constraints_all_evaluate_finite_at_initial_guess():
    index, network, x0, objective, constraints_list, _initial_lengths = _build_all()
    assert len(constraints_list) > 0
    for c in constraints_list:
        val = c["fun"](x0)
        assert np.isfinite(val)


def test_no_hard_degree_constraint_present():
    # The hard per-flap degree>=2 constraint was removed in favor of the
    # count-maximizing objective. Every OTHER constraint type's row count is
    # fully accounted for below -- if the total matches exactly, there's no
    # hidden extra len(leaf_ids) block of degree rows left over.
    index, network, x0, objective, constraints_list, _initial_lengths = _build_all()
    expected = (
        4 * len(network.direct_paths)  # angle (+/-) and length (+/-)
        + 2 * len(network.half_legs)  # angle (+/-)
        + 2 * len(network.indirect_paths)  # length (+/-)
        + len(network.nand_pairs)
        + 2 * len(network.point_groups)  # dangling lower + upper
        + len(network.overlap_pairs)
        + len(network.far_pairs)
    )
    assert len(constraints_list) == expected


def test_point_dangling_constraint_requires_at_least_three_legs():
    index, network, x0, objective, constraints_list, _initial_lengths = _build_all()
    group = next(iter(network.point_groups.values()))
    assert len(group.half_leg_ids) >= 3

    x = x0.copy()
    for col in index.all_boolean_cols():
        x[col] = 0.0
    leg_cols = [index.leg_col[leg_id] for leg_id in group.half_leg_ids]
    # Exactly 2 legs selected, point-active boolean left off -- the lower-
    # bound dangling constraint (sum >= MIN_VERTEX_DEGREE * a) must reject
    # this once a is forced toward 1 to justify a nonzero leg sum, and the
    # upper bound must reject leaving a at 0 while legs are selected.
    x[leg_cols[0]] = 1.0
    x[leg_cols[1]] = 1.0
    x[index.point_bool_col[group.id]] = 1.0
    violated = any(c["fun"](x) < -1e-9 for c in constraints_list if c["type"] == "ineq")
    assert violated
