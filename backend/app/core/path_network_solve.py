"""The continuation/round/polish/basin-hopping driver for the path-network
snap solve -- ties path_network.py's preprocessing and path_network_vars.py's
variable/constraint/objective builders into an actual solve.

Three stages per attempt (see the confirmed formulation):

1. Anneal + relax: a sequence of warm-started SLSQP solves with the boolean-
   relaxation penalty weight increasing each outer step, until every
   relaxed boolean is within `bool_eps` of 0 or 1. The angle/length big-M
   slacks are *also* shrunk every outer step (see `constraints_factory`) --
   a candidate sitting at an intermediate boolean value gets progressively
   less slack to hide behind, instead of the same loose bound the whole way
   through, which otherwise let the relaxation wander far from anything
   physically realizable before rounding ever happens.
2. Round + repair: round every boolean to {0, 1}; repair any point group
   whose leg count landed on something other than 0 or >= MIN_VERTEX_DEGREE
   (see path_network.py) by promoting it with the legs closest to already
   satisfying their own angle constraint, or dropping it back to 0 if there
   simply aren't enough legs available -- not just the highest relaxed
   boolean value, so the repair doesn't hand the polish stage a leg that's
   geometrically nowhere close to satisfiable. There's no longer a per-flap
   degree requirement to repair (removed along with the hard degree>=2
   constraint -- the count-maximizing objective is what drives selection
   now, not a floor every flap must individually clear).
3. Polish: one more solve with every boolean fixed at its rounded value --
   the "clean" NLP for the chosen topology. Constraints stay the same soft
   big-M gate used during relaxation (never a hard equality), so an
   over-constrained rounded topology absorbs residual error instead of
   failing outright. The M magnitude is irrelevant here (a fixed boolean
   makes the big-M term exactly 0 or moot), so whichever schedule step the
   anneal loop ended on is reused as-is.

All three are wrapped in a basin-hopping restart loop mirroring
solve_service.py's `_seeded_restarts`: restart 0 is the exact given seed,
every later restart perturbs the best attempt found so far (not always the
original seed) by a noise amplitude ramping from 0 up to `max_noise_amplitude`.
"""

import math
import random
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np
from scipy.optimize import minimize

from app.core.path_network import MIN_VERTEX_DEGREE, HalfLeg, PathNetworkPreprocessing
from app.core.path_network_vars import PathNetworkVariableIndex

ObjectiveFactory = Callable[[float], Callable[[np.ndarray], Tuple[float, np.ndarray]]]
ConstraintsFactory = Callable[[int], List[dict]]


def _half_leg_residual(
    leg: HalfLeg, positions: Dict[str, Tuple[float, float]], point_xy: Callable[[str], Tuple[float, float]]
) -> float:
    """How far the current (positions, point location) already are from
    exactly satisfying this leg's own angle constraint -- used to pick the
    safest legs to promote a too-small point group with, not just whichever
    had the highest relaxed boolean value."""
    n_hat = (-math.sin(leg.angle), math.cos(leg.angle))
    pf = positions[leg.flap]
    px, py = point_xy(leg.point_group_id)
    return abs(n_hat[0] * (px - pf[0]) + n_hat[1] * (py - pf[1]))


def _anneal_and_relax(
    index: PathNetworkVariableIndex,
    x0: np.ndarray,
    bounds: List[Tuple[Optional[float], Optional[float]]],
    constraints_factory: ConstraintsFactory,
    objective_factory: ObjectiveFactory,
    outer_iters: int,
    weight_start: float,
    weight_growth: float,
    bool_eps: float,
    method: str,
    tol: Optional[float],
    max_iter: Optional[int],
) -> Tuple[np.ndarray, List[dict]]:
    x = x0.copy()
    weight = weight_start
    options = {"maxiter": max_iter} if max_iter is not None else None
    bool_cols = index.all_boolean_cols()
    constraints = constraints_factory(0)

    for t in range(max(1, outer_iters)):
        constraints = constraints_factory(t)
        objective = objective_factory(weight)
        result = minimize(objective, x, jac=True, bounds=bounds, constraints=constraints, method=method, tol=tol, options=options)
        x = result.x
        if bool_cols:
            max_dev = max(abs(x[c] - round(x[c])) for c in bool_cols)
            if max_dev <= bool_eps:
                break
        weight *= weight_growth
    return x, constraints


def _round_and_repair(x: np.ndarray, index: PathNetworkVariableIndex, network: PathNetworkPreprocessing) -> np.ndarray:
    x = x.copy()
    bool_state: Dict[int, int] = {}
    for col in index.direct_col.values():
        bool_state[col] = 1 if x[col] >= 0.5 else 0
    for col in index.leg_col.values():
        bool_state[col] = 1 if x[col] >= 0.5 else 0

    positions = index.decode_positions(x)

    def point_xy(group_id: str) -> Tuple[float, float]:
        return index.decode_point_xy(x, group_id)

    leg_residual_by_col = {
        index.leg_col[leg.id]: _half_leg_residual(leg, positions, point_xy) for leg in network.half_legs.values()
    }

    # A point group's leg count must land on 0 or >= MIN_VERTEX_DEGREE, never
    # in between (see path_network.py) -- a leg belongs to exactly one point
    # group, so fixing one group's count can never disturb another's; a
    # single pass over every group is enough.
    for group in network.point_groups.values():
        leg_cols = [index.leg_col[leg_id] for leg_id in group.half_leg_ids]
        selected = [c for c in leg_cols if bool_state[c] == 1]
        if len(selected) == 0 or len(selected) >= MIN_VERTEX_DEGREE:
            continue
        others = sorted((c for c in leg_cols if bool_state[c] == 0), key=lambda c: leg_residual_by_col[c])
        needed = MIN_VERTEX_DEGREE - len(selected)
        if len(others) >= needed:
            for c in others[:needed]:
                bool_state[c] = 1
        else:
            for c in selected:
                bool_state[c] = 0

    for col, val in bool_state.items():
        x[col] = float(val)
    for p_id, group in network.point_groups.items():
        leg_cols = [index.leg_col[leg_id] for leg_id in group.half_leg_ids]
        active = 1.0 if sum(bool_state[c] for c in leg_cols) >= MIN_VERTEX_DEGREE else 0.0
        x[index.point_bool_col[p_id]] = active
    return x


def _polish(
    x: np.ndarray,
    index: PathNetworkVariableIndex,
    base_bounds: List[Tuple[Optional[float], Optional[float]]],
    constraints: List[dict],
    objective_factory: ObjectiveFactory,
    method: str,
    tol: Optional[float],
    max_iter: Optional[int],
) -> Tuple[np.ndarray, float, bool]:
    bool_cols = set(index.all_boolean_cols())
    bounds = [(x[i], x[i]) if i in bool_cols else base_bounds[i] for i in range(len(base_bounds))]
    objective = objective_factory(0.0)
    options = {"maxiter": max_iter} if max_iter is not None else None
    result = minimize(objective, x, jac=True, bounds=bounds, constraints=constraints, method=method, tol=tol, options=options)
    return result.x, float(result.fun), bool(result.success)


def solve_path_network_once(
    index: PathNetworkVariableIndex,
    network: PathNetworkPreprocessing,
    x0: np.ndarray,
    bounds: List[Tuple[Optional[float], Optional[float]]],
    constraints_factory: ConstraintsFactory,
    objective_factory: ObjectiveFactory,
    outer_iters: int,
    weight_start: float,
    weight_growth: float,
    bool_eps: float,
    method: str = "slsqp",
    tol: Optional[float] = None,
    max_iter: Optional[int] = None,
) -> Tuple[np.ndarray, float, bool]:
    x_relaxed, constraints = _anneal_and_relax(
        index, x0, bounds, constraints_factory, objective_factory, outer_iters, weight_start, weight_growth, bool_eps, method, tol, max_iter
    )
    x_rounded = _round_and_repair(x_relaxed, index, network)
    return _polish(x_rounded, index, bounds, constraints, objective_factory, method, tol, max_iter)


def _perturb_continuous_vars(x0: np.ndarray, index: PathNetworkVariableIndex, rng: random.Random, noise: float) -> np.ndarray:
    x = x0.copy()
    for i in range(index.plan.n_position_vars):
        x[i] = x[i] + rng.uniform(-noise, noise)
    for e in index.length_ids:
        col = index.length_col[e]
        factor = 1.0 + rng.uniform(-noise, noise)
        x[col] = max(x[col] * factor, 1e-6)
    return x


def solve_path_network_basin_hopping(
    index: PathNetworkVariableIndex,
    network: PathNetworkPreprocessing,
    base_x0: np.ndarray,
    bounds: List[Tuple[Optional[float], Optional[float]]],
    constraints_factory: ConstraintsFactory,
    objective_factory: ObjectiveFactory,
    n_restarts: int,
    max_noise_amplitude: float,
    outer_iters: int,
    weight_start: float,
    weight_growth: float,
    bool_eps: float,
    method: str = "slsqp",
    tol: Optional[float] = None,
    max_iter: Optional[int] = None,
    seed: Optional[int] = None,
) -> Tuple[np.ndarray, float, bool]:
    rng = random.Random(seed)
    anchor_x, anchor_value, anchor_success = solve_path_network_once(
        index, network, base_x0, bounds, constraints_factory, objective_factory,
        outer_iters, weight_start, weight_growth, bool_eps, method, tol, max_iter,
    )
    for i in range(1, max(1, n_restarts)):
        noise = max_noise_amplitude * i / max(1, n_restarts - 1)
        candidate_x0 = _perturb_continuous_vars(anchor_x, index, rng, noise)
        cand_x, cand_value, cand_success = solve_path_network_once(
            index, network, candidate_x0, bounds, constraints_factory, objective_factory,
            outer_iters, weight_start, weight_growth, bool_eps, method, tol, max_iter,
        )
        if (cand_success, -cand_value) > (anchor_success, -anchor_value):
            anchor_x, anchor_value, anchor_success = cand_x, cand_value, cand_success
    return anchor_x, anchor_value, anchor_success
