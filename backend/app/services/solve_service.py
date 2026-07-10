import random
import time
from typing import List, Set, Tuple

import networkx as nx
import numpy as np

from app.core.constraint_resolution import (
    collect_resolved_points,
    find_any_collision,
    mirror_corner,
    mirror_edge,
    resolve_leaf_constraint,
)
from app.core.layout import solve_internal_layout
from app.core.packing import run_circle_restart, run_polygon_restart
from app.core.shapes import extra_rotation_for, get_bases
from app.core.tree import build_tree, get_leaves, total_edge_length
from app.core.variable_plan import VariablePlan
from app.schemas.constraints import Constraints
from app.schemas.hyperparams import Hyperparams
from app.schemas.solve import InitFrom, NodePositionOut, SolveDiagnostics, SolveRequest, SolveResponse


def _validate_constraints(leaf_ids: Set[str], all_node_ids: Set[str], constraints: Constraints) -> None:
    for a, b in constraints.equal_pairs.items():
        if a not in all_node_ids or b not in all_node_ids:
            raise ValueError(f"equal-size constraint references unknown node '{a}' or '{b}'")
        if constraints.equal_pairs.get(b) != a:
            raise ValueError(f"'{a}' and '{b}' must be mutually and exclusively equal-paired")
        if (a in leaf_ids) != (b in leaf_ids):
            raise ValueError(f"'{a}' and '{b}' can't be equal-paired -- one is a flap and the other a river")

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
                mirrors = False
                if c.boundary.kind == "pin_edge" and partner_c.boundary.kind == "pin_edge":
                    mirrors = mirror_edge(constraints.symmetry_mode, c.boundary.edge) == partner_c.boundary.edge
                elif c.boundary.kind == "pin_corner" and partner_c.boundary.kind == "pin_corner":
                    mirrors = mirror_corner(constraints.symmetry_mode, c.boundary.corner) == partner_c.boundary.corner
                if not mirrors:
                    raise ValueError(
                        f"'{leaf_id}' and '{partner}' have edge/corner pins that are not mirrors of each other"
                    )
        if c.boundary.kind == "pin_edge" and c.boundary.edge is None:
            raise ValueError(f"'{leaf_id}' has a pin_edge constraint with no edge specified")
        if c.boundary.kind == "pin_corner" and c.boundary.corner is None:
            raise ValueError(f"'{leaf_id}' has a pin_corner constraint with no corner specified")
        if c.locked.kind == "locked":
            if c.locked.point is None:
                raise ValueError(f"'{leaf_id}' has a locked constraint with no point specified")
            if c.symmetry.kind == "pair" and leaf_id > c.symmetry.paired_with:
                raise ValueError(
                    f"'{leaf_id}' is the non-leader half of a pair and can't be locked independently "
                    f"of '{c.symmetry.paired_with}'"
                )
        if not resolve_leaf_constraint(constraints.symmetry_mode, c).feasible:
            raise ValueError(
                f"'{leaf_id}' combines symmetry and boundary constraints that can never be satisfied together"
            )

    collision = find_any_collision(collect_resolved_points(list(leaf_ids), constraints))
    if collision is not None:
        a, b = collision
        raise ValueError(f"'{a.leaf_id}' and '{b.leaf_id}' resolve to the same fixed position")


def _perturb_position_vars(x0: np.ndarray, n_position_vars: int, rng: random.Random, noise: float) -> np.ndarray:
    """Displaces every position variable by up to +/-noise. Deliberately NOT
    clamped back into [0, 1] -- scipy's constrained local minimize doesn't
    require a feasible starting point, and letting a perturbed flap sit
    outside the square lets the search actually explore past that boundary
    instead of piling up against it."""
    x = x0.copy()
    for i in range(n_position_vars):
        x[i] = x[i] + rng.uniform(-noise, noise)
    return x


def _seeded_restarts(
    plan: VariablePlan,
    tree: nx.DiGraph,
    base_x0: np.ndarray,
    hp: Hyperparams,
    solver_args: tuple,
) -> List[Tuple[np.ndarray, float, bool]]:
    """Restart generation for initFrom=CURRENT (a re-optimize, not the very
    first solve): restart 0 is always the exact unperturbed seed, so this
    can never do worse than the old single-shot behavior. Every later
    restart perturbs the BEST local minimum found so far -- not always the
    original seed -- by an amount ramping from 0 to hp.max_noise_amplitude
    across the restart budget, greedily wandering into neighboring basins
    instead of re-exploring the same neighborhood around the starting point
    every time. This is the simplest (zero-temperature/greedy) variant of
    Wales & Doye's basin-hopping algorithm (1997) -- always keep the better
    of the two candidates, never accept a worse one -- which needs no extra
    temperature hyperparameter while still escaping shallow local minima
    that a plain multi-start anchored on one fixed point cannot. A true
    Metropolis acceptance criterion (occasionally accepting a worse move to
    escape deeper traps) would need a temperature schedule the user has no
    way to reason about yet; the greedy variant is the well-established
    simplification that avoids that without giving up the core benefit.
    Ranks candidates the same way the caller ranks restarts overall: by
    (success, scale), so a non-converged perturbation can never displace a
    converged anchor regardless of its reported scale."""
    rng = random.Random(hp.seed)
    n = hp.n_restarts
    results = [run_circle_restart(plan, tree, base_x0, *solver_args)]
    anchor_x, anchor_scale, anchor_success = results[0]
    for i in range(1, n):
        noise = hp.max_noise_amplitude * i / (n - 1)
        candidate_x0 = _perturb_position_vars(anchor_x, plan.n_position_vars, rng, noise)
        result = run_circle_restart(plan, tree, candidate_x0, *solver_args)
        results.append(result)
        _, candidate_scale, candidate_success = result
        if (candidate_success, candidate_scale) > (anchor_success, anchor_scale):
            anchor_x, anchor_scale, anchor_success = result
    return results


def _normalize_equal_lengths(tree: nx.DiGraph, leaf_ids: List[str], constraints: Constraints) -> None:
    """For every equal-size pair where both sides are leaves, sets both
    edges to their average -- radius formulas depend on length, and this
    must happen before the VariablePlan (and its bounds/decode) are built.
    River-river equal pairs need no backend handling: their lengths are pure
    display inputs the solver never reads for its own math, and the
    frontend already keeps them in sync before any request is sent. This
    replaces the old symmetry-`pair`-only averaging -- equal-size is now an
    independent constraint (see types/constraints.ts's `equalPairs`) that a
    symmetry pair merely defaults to, so only leaves actually carrying the
    equal constraint get force-averaged here."""
    seen: Set[str] = set()
    leaf_id_set = set(leaf_ids)
    for a, b in constraints.equal_pairs.items():
        if a in seen or a not in leaf_id_set or b not in leaf_id_set:
            continue
        seen.add(a)
        seen.add(b)
        parent_a = next(tree.predecessors(a))
        parent_b = next(tree.predecessors(b))
        avg = (tree.edges[parent_a, a]["length"] + tree.edges[parent_b, b]["length"]) / 2
        tree.edges[parent_a, a]["length"] = avg
        tree.edges[parent_b, b]["length"] = avg


def solve(req: SolveRequest) -> SolveResponse:
    start = time.perf_counter()
    tree = build_tree(req.tree)
    leaf_ids = get_leaves(tree)
    hp = req.hyperparams

    _validate_constraints(set(leaf_ids), set(tree.nodes), req.constraints)
    _normalize_equal_lengths(tree, leaf_ids, req.constraints)
    plan = VariablePlan(leaf_ids, req.constraints)

    solver_args = (hp.solver_method, hp.tol, hp.max_iter)

    if req.init_from == InitFrom.CURRENT:
        if req.current_positions is None or req.current_scale is None:
            raise ValueError("initFrom is 'current' but currentPositions/currentScale were not provided")
        current_positions = {p.node_id: (p.x, p.y) for p in req.current_positions}
        base_x0 = plan.encode_from_positions(current_positions, req.current_scale)
        if req.seed_multi_restart and hp.n_restarts > 1:
            circle_results = _seeded_restarts(plan, tree, base_x0, hp, solver_args)
        else:
            circle_results = [run_circle_restart(plan, tree, base_x0, *solver_args)]
    else:
        rng = random.Random(hp.seed)
        total_length = total_edge_length(tree)
        scale_guess = 2.0 / total_length if total_length > 0 else 1.0
        circle_results = [
            run_circle_restart(plan, tree, plan.random_initial_guess(rng, scale_guess), *solver_args)
            for _ in range(hp.n_restarts)
        ]
    # Sort by (success, scale) so a non-converged restart can never out-rank
    # a converged one, regardless of its reported (possibly bogus,
    # constraint-violating) scale -- falls back to ranking by scale alone
    # only when every restart failed to converge.
    circle_results.sort(key=lambda r: (r[2], r[1]), reverse=True)
    best_circle_scale = circle_results[0][1]

    extra_rotation = extra_rotation_for(
        hp.shape, hp.hexagon_extra_rotation, hp.square_extra_rotation, hp.dodecagon_extra_rotation
    )
    bases = get_bases(hp.shape, req.constraints.symmetry_mode, extra_rotation)
    best_scale_refined = None
    if bases is not None:
        top = circle_results[: max(1, hp.n_refine)]
        refined_results = [
            run_polygon_restart(plan, tree, x, hp.alpha, bases, *solver_args) for x, _scale, _success in top
        ]
        best_x, best_scale, _success = max(refined_results, key=lambda r: (r[2], r[1]))
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
