from typing import Dict, Tuple

from app.core.path_network import compute_path_network
from app.core.path_network_solve import solve_path_network_basin_hopping
from app.core.path_network_vars import PathNetworkVariableIndex, build_constraints, build_initial_guess, build_objective
from app.core.shapes import extra_rotation_for, get_bases
from app.core.tree import build_tree, get_leaves
from app.core.variable_plan import VariablePlan
from app.schemas.path_network import PathNetworkRequest, PathNetworkResponse, SelectedDirectPathOut, SelectedLegOut
from app.schemas.snap import NodeLengthOut
from app.schemas.solve import NodePositionOut

# Same restriction as the linear snap-paths feature -- circle has no
# discrete face-normal directions to snap to, and square is out of scope.
SNAPPABLE_SHAPES = {"hexagon", "octagon", "dodecagon"}


def solve_path_network(req: PathNetworkRequest) -> PathNetworkResponse:
    hp = req.hyperparams
    if hp.shape not in SNAPPABLE_SHAPES:
        raise ValueError(f"path-network snap isn't supported for shape '{hp.shape}' yet")

    tree = build_tree(req.tree)
    leaf_ids = get_leaves(tree)
    length_ids = [n for n in tree.nodes if n != req.tree.root_id]
    positions: Dict[str, Tuple[float, float]] = {p.node_id: (p.x, p.y) for p in req.positions}

    missing = [leaf_id for leaf_id in leaf_ids if leaf_id not in positions]
    if missing:
        raise ValueError(f"missing current position for leaf(s): {', '.join(missing)}")

    initial_lengths = {e: tree.edges[next(tree.predecessors(e)), e]["length"] for e in length_ids}

    extra_rotation = extra_rotation_for(
        hp.shape, hp.hexagon_extra_rotation, hp.square_extra_rotation, hp.dodecagon_extra_rotation
    )

    network = compute_path_network(
        tree,
        leaf_ids,
        positions,
        req.scale,
        hp.shape,
        req.constraints.symmetry_mode,
        extra_rotation,
        hp.active_snap_length_tolerance,
        hp.active_snap_angle_tolerance,
    )
    if network is None or (not network.direct_paths and not network.indirect_paths):
        return PathNetworkResponse(status="ok", message="no candidate paths found in the current layout")

    plan = VariablePlan(leaf_ids, req.constraints)
    index = PathNetworkVariableIndex.build(plan, length_ids, network)
    x0 = build_initial_guess(index, network, positions, initial_lengths)
    bounds = index.bounds(initial_lengths, hp.path_network_growth_cap)

    def objective_factory(weight: float):
        return build_objective(
            index,
            positions,
            initial_lengths,
            hp.path_network_count_weight,
            hp.path_network_c1,
            hp.path_network_c2,
            hp.path_network_c3,
            req.constraints.symmetry_mode,
            weight,
        )

    bases = get_bases(hp.shape, req.constraints.symmetry_mode, extra_rotation)

    def constraints_factory(iteration: int):
        # Both big-M slacks shrink geometrically every outer anneal
        # iteration, never below the floor -- see path_network_solve.py's
        # docstring for why this (not just the boolean-entropy weight) is
        # what stops a half-selected candidate from dragging positions/
        # lengths far from anything physically realizable before rounding.
        decay = hp.path_network_m_decay**iteration
        m_angle = max(hp.path_network_m_floor, hp.path_network_m_angle_start * decay)
        m_length = max(hp.path_network_m_floor, hp.path_network_m_length_start * decay)
        return build_constraints(
            index, network, tree, req.scale, hp.alpha, bases, req.constraints.equal_pairs, m_angle, m_length
        )

    x_final, _value, success = solve_path_network_basin_hopping(
        index,
        network,
        x0,
        bounds,
        constraints_factory,
        objective_factory,
        hp.path_network_n_restarts,
        hp.path_network_max_noise_amplitude,
        hp.path_network_anneal_outer_iters,
        hp.path_network_anneal_weight_start,
        hp.path_network_anneal_weight_growth,
        hp.path_network_bool_eps,
        hp.solver_method,
        hp.tol,
        hp.max_iter,
        hp.seed,
    )

    positions_out = index.decode_positions(x_final)
    lengths_out = index.decode_lengths(x_final)

    selected_direct = [
        SelectedDirectPathOut(a=d.a, b=d.b) for d in network.direct_paths if x_final[index.direct_col[d.id]] >= 0.5
    ]
    selected_legs = []
    for leg in network.half_legs.values():
        if x_final[index.leg_col[leg.id]] < 0.5:
            continue
        x, y = index.decode_point_xy(x_final, leg.point_group_id)
        selected_legs.append(SelectedLegOut(flap=leg.flap, point_id=leg.point_group_id, x=x, y=y))

    message = None if success else "path-network solve did not fully converge -- showing the best result found"

    return PathNetworkResponse(
        status="ok",
        message=message,
        leaf_positions=[NodePositionOut(node_id=leaf_id, x=x, y=y) for leaf_id, (x, y) in positions_out.items()],
        lengths=[NodeLengthOut(node_id=e, length=lengths_out[e]) for e in length_ids],
        selected_direct_paths=selected_direct,
        selected_legs=selected_legs,
    )
