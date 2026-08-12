import math

import numpy as np

from app.core.path_network import MIN_VERTEX_DEGREE, compute_path_network
from app.core.path_network_solve import _round_and_repair, solve_path_network_basin_hopping
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
    degree-3 point group to exercise repair/solve against."""
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


def _build_all():
    tree, positions, scale = _triplet_tree_and_positions()
    leaf_ids = get_leaves(tree)
    plan = VariablePlan(leaf_ids, Constraints())
    length_ids = [n for n in tree.nodes if n != "root"]
    initial_lengths = {e: tree.edges[next(tree.predecessors(e)), e]["length"] for e in length_ids}

    network = compute_path_network(
        tree, leaf_ids, positions, scale=scale, shape="octagon", symmetry_mode="none",
        extra_rotation=False, length_tolerance=0.05, angle_tolerance_degrees=10.0,
    )
    assert network is not None
    index = PathNetworkVariableIndex.build(plan, length_ids, network)
    x0 = build_initial_guess(index, network, positions, initial_lengths)

    def objective_factory(weight):
        return build_objective(index, positions, initial_lengths, 1.0, 0.01, 0.001, 0.001, SymmetryMode.NONE, weight)

    def constraints_factory(iteration):
        m = max(0.05, 4.0 * (0.5**iteration))
        return build_constraints(index, network, tree, scale=scale, alpha=100.0, bases=None, equal_pairs={}, m_angle=m, m_length=m)

    return network, index, x0, objective_factory, constraints_factory, initial_lengths


def test_round_and_repair_promotes_a_too_small_group_to_min_vertex_degree():
    network, index, x0, objective_factory, constraints_factory, initial_lengths = _build_all()

    group = next(iter(network.point_groups.values()))
    assert len(group.half_leg_ids) >= MIN_VERTEX_DEGREE

    # Force a pathological relaxed state: every candidate off except exactly
    # one leg of a viable group -- a count of 1, which the {0}u[3,inf)
    # dangling rule bans, but which has enough OTHER members to reach 3.
    x = x0.copy()
    for col in index.direct_col.values():
        x[col] = 0.0
    for col in index.leg_col.values():
        x[col] = 0.0
    lone_leg_id = group.half_leg_ids[0]
    x[index.leg_col[lone_leg_id]] = 0.9

    repaired = _round_and_repair(x, index, network)

    for g in network.point_groups.values():
        leg_cols = [index.leg_col[leg_id] for leg_id in g.half_leg_ids]
        count = sum(1 for c in leg_cols if repaired[c] >= 0.5)
        assert count == 0 or count >= MIN_VERTEX_DEGREE, f"group {g.id} has an invalid count of {count}"

    # The forced-on lone leg's group specifically reached >=3, not 0 --
    # there were enough other members available to promote it.
    leg_cols = [index.leg_col[leg_id] for leg_id in group.half_leg_ids]
    count = sum(1 for c in leg_cols if repaired[c] >= 0.5)
    assert count >= MIN_VERTEX_DEGREE

    for col in list(index.direct_col.values()) + list(index.leg_col.values()) + list(index.point_bool_col.values()):
        assert repaired[col] in (0.0, 1.0)


def test_round_and_repair_drops_impossible_group_to_zero():
    # Real preprocessing (compute_path_network) never returns a point group
    # with fewer than MIN_VERTEX_DEGREE members -- doomed groups are removed
    # before it returns (see path_network.py). So exercising the "not enough
    # others, drop to 0" branch means hand-building a network where a group
    # genuinely only has 2 members, which no real layout could produce.
    network, index, x0, objective_factory, constraints_factory, initial_lengths = _build_all()
    real_group = next(iter(network.point_groups.values()))
    two_leg_ids = real_group.half_leg_ids[:2]

    from app.core.path_network import PathNetworkPreprocessing, PointGroup

    # Reuses real_group's own id (so index.point_bool_col already has a
    # column for it) but truncates its membership to 2 -- and is the ONLY
    # group present, so there's no interference from a second (3-member)
    # group also getting repaired in this same call.
    stub_group = PointGroup(id=real_group.id, natural_point=(0.0, 0.0), half_leg_ids=two_leg_ids)
    stub_network = PathNetworkPreprocessing(
        direct_paths=network.direct_paths,
        indirect_paths=network.indirect_paths,
        half_legs=network.half_legs,
        point_groups={stub_group.id: stub_group},
        nand_pairs=network.nand_pairs,
        overlap_pairs=network.overlap_pairs,
        far_pairs=network.far_pairs,
    )

    x = x0.copy()
    for col in index.direct_col.values():
        x[col] = 0.0
    for col in index.leg_col.values():
        x[col] = 0.0
    x[index.leg_col[two_leg_ids[0]]] = 1.0

    repaired = _round_and_repair(x, index, stub_network)
    stub_leg_cols = [index.leg_col[leg_id] for leg_id in two_leg_ids]
    count = sum(1 for c in stub_leg_cols if repaired[c] >= 0.5)
    assert count == 0


def test_basin_hopping_end_to_end_produces_valid_discrete_topology():
    network, index, x0, objective_factory, constraints_factory, initial_lengths = _build_all()
    bounds = index.bounds(initial_lengths, growth_cap=3.0)

    x_final, value, success = solve_path_network_basin_hopping(
        index, network, x0, bounds, constraints_factory, objective_factory,
        n_restarts=2, max_noise_amplitude=0.05, outer_iters=3, weight_start=1.0, weight_growth=3.0,
        bool_eps=0.05, method="slsqp", seed=0,
    )

    assert np.isfinite(value)
    bool_cols = index.all_boolean_cols()
    for col in bool_cols:
        assert x_final[col] == 0.0 or x_final[col] == 1.0

    for group in network.point_groups.values():
        leg_cols = [index.leg_col[leg_id] for leg_id in group.half_leg_ids]
        count = sum(1 for c in leg_cols if x_final[c] == 1.0)
        assert count == 0 or count >= MIN_VERTEX_DEGREE

    # Intermediate points are bounded exactly like a flap position -- an
    # angle constraint alone can't stop a point from running arbitrarily far
    # along the correct direction, so the box bound is what actually does it.
    assert len(network.point_groups) > 0
    for p_id in index.point_ids:
        px, py = index.decode_point_xy(x_final, p_id)
        assert 0.0 <= px <= 1.0
        assert 0.0 <= py <= 1.0


def test_point_coordinates_never_exceed_unit_square_even_unconstrained():
    # A pathological relaxed state where every boolean (including the
    # point's own "active" flag) is 0 -- nothing but the box bound itself
    # should be holding the point's position down, since an inactive point
    # has no angle/length constraint biting on it at all.
    network, index, x0, objective_factory, constraints_factory, initial_lengths = _build_all()
    bounds = index.bounds(initial_lengths, growth_cap=3.0)
    constraints = constraints_factory(0)
    objective = objective_factory(0.0)

    x = x0.copy()
    for col in index.direct_col.values():
        x[col] = 0.0
    for col in index.leg_col.values():
        x[col] = 0.0
    for col in index.point_bool_col.values():
        x[col] = 0.0

    from scipy.optimize import minimize

    result = minimize(objective, x, jac=True, bounds=bounds, constraints=constraints, method="slsqp")
    for p_id in index.point_ids:
        px, py = index.decode_point_xy(result.x, p_id)
        assert 0.0 <= px <= 1.0
        assert 0.0 <= py <= 1.0
