import random
import time
from typing import Set

import networkx as nx

from app.core.constraint_resolution import collect_resolved_points, find_any_collision, resolve_leaf_constraint
from app.core.layout import solve_internal_layout
from app.core.packing import run_circle_restart, run_polygon_restart
from app.core.shapes import get_bases
from app.core.tree import build_tree, get_leaves, total_edge_length
from app.core.variable_plan import VariablePlan
from app.schemas.constraints import Constraints
from app.schemas.solve import InitFrom, NodePositionOut, SolveDiagnostics, SolveRequest, SolveResponse


def _validate_constraints(leaf_ids: Set[str], constraints: Constraints) -> None:
    for leaf_id, c in constraints.per_leaf.items():
        if leaf_id not in leaf_ids:
            raise ValueError(f"constraint references unknown leaf '{leaf_id}'")
        if c.symmetry.kind in ("pin_symmetry", "pair") and constraints.symmetry_mode == "none":
            raise ValueError(f"'{leaf_id}' has a {c.symmetry.kind} constraint but symmetryMode is none")
        if c.symmetry.kind == "pair":
            partner = c.symmetry.paired_with
            if not partner or partner not in leaf_ids:
                raise ValueError(f"'{leaf_id}' is paired with an invalid leaf '{partner}'")
            partner_c = constraints.per_leaf.get(partner)
            if not partner_c or partner_c.symmetry.kind != "pair" or partner_c.symmetry.paired_with != leaf_id:
                raise ValueError(f"'{leaf_id}' and '{partner}' must be mutually and exclusively paired")
            if c.boundary.kind != "none" and partner_c.boundary.kind != "none":
                raise ValueError(f"only one of '{leaf_id}'/'{partner}' may have an edge/corner pin")
        if c.boundary.kind == "pin_edge" and c.boundary.edge is None:
            raise ValueError(f"'{leaf_id}' has a pin_edge constraint with no edge specified")
        if c.boundary.kind == "pin_corner" and c.boundary.corner is None:
            raise ValueError(f"'{leaf_id}' has a pin_corner constraint with no corner specified")
        if not resolve_leaf_constraint(constraints.symmetry_mode, c).feasible:
            raise ValueError(
                f"'{leaf_id}' combines symmetry and boundary constraints that can never be satisfied together"
            )

    collision = find_any_collision(collect_resolved_points(list(leaf_ids), constraints))
    if collision is not None:
        a, b = collision
        raise ValueError(f"'{a.leaf_id}' and '{b.leaf_id}' resolve to the same fixed position")


def _normalize_paired_lengths(tree: nx.DiGraph, constraints: Constraints) -> None:
    """For every pair, sets both leaves' edge lengths to their average --
    radius formulas depend on length, and this must happen before the
    VariablePlan (and its bounds/decode) are built."""
    seen: Set[str] = set()
    for leaf_id, c in constraints.per_leaf.items():
        if c.symmetry.kind != "pair" or leaf_id in seen:
            continue
        partner = c.symmetry.paired_with
        seen.add(leaf_id)
        seen.add(partner)
        parent_a = next(tree.predecessors(leaf_id))
        parent_b = next(tree.predecessors(partner))
        avg = (tree.edges[parent_a, leaf_id]["length"] + tree.edges[parent_b, partner]["length"]) / 2
        tree.edges[parent_a, leaf_id]["length"] = avg
        tree.edges[parent_b, partner]["length"] = avg


def solve(req: SolveRequest) -> SolveResponse:
    start = time.perf_counter()
    tree = build_tree(req.tree)
    leaf_ids = get_leaves(tree)
    hp = req.hyperparams

    _validate_constraints(set(leaf_ids), req.constraints)
    _normalize_paired_lengths(tree, req.constraints)
    plan = VariablePlan(leaf_ids, req.constraints)

    if req.init_from == InitFrom.CURRENT:
        if req.current_positions is None or req.current_scale is None:
            raise ValueError("initFrom is 'current' but currentPositions/currentScale were not provided")
        current_positions = {p.node_id: (p.x, p.y) for p in req.current_positions}
        x0 = plan.encode_from_positions(current_positions, req.current_scale)
        circle_results = [run_circle_restart(plan, tree, x0)]
    else:
        rng = random.Random(hp.seed)
        total_length = total_edge_length(tree)
        scale_guess = 2.0 / total_length if total_length > 0 else 1.0
        circle_results = [
            run_circle_restart(plan, tree, plan.random_initial_guess(rng, scale_guess))
            for _ in range(hp.n_restarts)
        ]
    circle_results.sort(key=lambda r: r[1], reverse=True)
    best_circle_scale = circle_results[0][1]

    bases = get_bases(hp.shape)
    best_scale_refined = None
    if bases is not None:
        top = circle_results[: max(1, hp.n_refine)]
        refined_results = [run_polygon_restart(plan, tree, x, hp.alpha, bases) for x, _scale, _success in top]
        best_x, best_scale, _success = max(refined_results, key=lambda r: r[1])
        best_scale_refined = best_scale
    else:
        best_x, best_scale, _success = circle_results[0]

    leaf_positions_dict, best_scale = plan.decode(best_x)
    internal_positions_dict = solve_internal_layout(tree, leaf_positions_dict, best_scale)

    elapsed_ms = (time.perf_counter() - start) * 1000
    return SolveResponse(
        status="ok",
        scale=float(best_scale),
        leaf_positions=[
            NodePositionOut(node_id=node_id, x=x, y=y) for node_id, (x, y) in leaf_positions_dict.items()
        ],
        internal_positions=[
            NodePositionOut(node_id=node_id, x=x, y=y) for node_id, (x, y) in internal_positions_dict.items()
        ],
        diagnostics=SolveDiagnostics(
            restarts_attempted=len(circle_results),
            best_scale_circle=float(best_circle_scale),
            best_scale_refined=best_scale_refined,
            solve_time_ms=elapsed_ms,
        ),
    )
