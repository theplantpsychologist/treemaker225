"""Variable layout, constraint builders, and the objective (with an
analytical gradient) for the path-network snap solve.

Variable vector layout (in order): leaf position free-variables (the same
reduced set VariablePlan already computes from symmetry/boundary/locked
constraints -- this solve reuses VariablePlan purely for that DOF reduction
and never touches its trailing scale slot, since scale is a fixed input
here, not a variable), one column per tree-edge length, one relaxed boolean
per direct-path candidate, one relaxed boolean per half-leg, one relaxed
"is this point active" boolean per point group, and finally two columns
(x, y) per point group.

Every angle/length relationship that should only hold when some candidate is
"selected" is expressed as a big-M gated pair of inequalities rather than a
hard equality -- exactly the mechanism from the confirmed formulation: with
boolean b relaxed to [0,1], `|residual| <= BIG_M*(1-b)` is vacuous at b=0 and
forces near-exact equality at b=1, and (per the polish-phase decision) is
kept even after b is rounded to a hard 0/1, so an over-constrained topology
degrades to a small residual instead of a solver failure.
"""

import math
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import networkx as nx
import numpy as np

from app.core.active_paths import path_edge_ids
from app.core.packing import smooth_max
from app.core.path_network import MIN_VERTEX_DEGREE, PathNetworkPreprocessing
from app.core.tree import find_distance
from app.core.variable_plan import VariablePlan
from app.schemas.constraints import SymmetryMode

# Generously large relative to the packing square / typical tree-length
# scale -- only needs to make a gated constraint vacuous at b=0, never binds
# when b=1.
BIG_M = 10.0


@dataclass
class PathNetworkVariableIndex:
    plan: VariablePlan
    length_ids: List[str]
    direct_ids: List[str]
    leg_ids: List[str]
    point_ids: List[str]
    length_col: Dict[str, int]
    direct_col: Dict[str, int]
    leg_col: Dict[str, int]
    point_bool_col: Dict[str, int]
    point_xy_col: Dict[str, int]
    n_cols: int

    @classmethod
    def build(
        cls, plan: VariablePlan, length_ids: List[str], network: PathNetworkPreprocessing
    ) -> "PathNetworkVariableIndex":
        idx = plan.n_position_vars
        length_col = {e: idx + i for i, e in enumerate(length_ids)}
        idx += len(length_ids)

        direct_ids = [d.id for d in network.direct_paths]
        direct_col = {d_id: idx + i for i, d_id in enumerate(direct_ids)}
        idx += len(direct_ids)

        leg_ids = list(network.half_legs.keys())
        leg_col = {leg_id: idx + i for i, leg_id in enumerate(leg_ids)}
        idx += len(leg_ids)

        point_ids = list(network.point_groups.keys())
        point_bool_col = {p_id: idx + i for i, p_id in enumerate(point_ids)}
        idx += len(point_ids)

        point_xy_col: Dict[str, int] = {}
        for p_id in point_ids:
            point_xy_col[p_id] = idx
            idx += 2

        return cls(plan, length_ids, direct_ids, leg_ids, point_ids, length_col, direct_col, leg_col, point_bool_col, point_xy_col, idx)

    def bounds(
        self, initial_lengths: Dict[str, float], growth_cap: float
    ) -> List[Tuple[Optional[float], Optional[float]]]:
        b: List[Tuple[Optional[float], Optional[float]]] = []
        for leaf_id in self.plan.leaf_ids:
            b += [(0.0, 1.0)] * self.plan.specs[leaf_id].n_vars
        # Not a literal 0 floor -- a length of exactly 0 makes the spectral
        # mesh's per-segment normalized length (and hence its conductance)
        # singular. Indistinguishable from "0 is fine" at rendering scale.
        # The upper bound is the real fix for the runaway-length failure
        # mode: without it, any length whose every pair got pruned from the
        # non-overlap check (see path_network.py's far_pairs) had nothing at
        # all stopping it from growing without limit under a nonzero C2.
        for e in self.length_ids:
            b.append((1e-6, max(initial_lengths[e] * growth_cap, 2e-6)))
        b += [(0.0, 1.0)] * len(self.direct_ids)
        b += [(0.0, 1.0)] * len(self.leg_ids)
        b += [(0.0, 1.0)] * len(self.point_ids)
        # Bounded exactly like a flap position, not left unbounded -- an
        # angle constraint only pins the PERPENDICULAR component of
        # (point - flap); nothing else stops a point from running
        # arbitrarily far along the correct direction (the length
        # relationship that would catch that only exists for an indirect
        # candidate whose BOTH legs are selected). Confining the domain to
        # the same [0,1] square every flap already lives in is what makes
        # the leg angle constraint (which already shares m_angle with the
        # direct-path one -- see build_constraints) actually as strict in
        # practice, not just in the M value.
        for _ in self.point_ids:
            b += [(0.0, 1.0), (0.0, 1.0)]
        return b

    def decode_positions(self, x: np.ndarray) -> Dict[str, Tuple[float, float]]:
        padded = np.concatenate([x[: self.plan.n_position_vars], [1.0]])
        positions, _ = self.plan.decode(padded)
        return positions

    def decode_lengths(self, x: np.ndarray) -> Dict[str, float]:
        return {e: float(x[c]) for e, c in self.length_col.items()}

    def decode_point_xy(self, x: np.ndarray, point_id: str) -> Tuple[float, float]:
        c = self.point_xy_col[point_id]
        return float(x[c]), float(x[c + 1])

    def all_boolean_cols(self) -> List[int]:
        return list(self.direct_col.values()) + list(self.leg_col.values()) + list(self.point_bool_col.values())


def build_initial_guess(
    index: PathNetworkVariableIndex,
    network: PathNetworkPreprocessing,
    initial_positions: Dict[str, Tuple[float, float]],
    initial_lengths: Dict[str, float],
) -> np.ndarray:
    padded = index.plan.encode_from_positions(initial_positions, 1.0)
    x0 = np.zeros(index.n_cols)
    x0[: index.plan.n_position_vars] = padded[: index.plan.n_position_vars]
    for e in index.length_ids:
        x0[index.length_col[e]] = initial_lengths[e]

    # Seed each candidate's relaxed boolean from how confidently it already
    # satisfies its own tangency test in the current layout (see
    # path_network.py's `_confidence`) -- closer/overlapping pairs start
    # near 1 (likely meant to be selected), pairs near the tolerance
    # boundary start near 0, instead of a neutral 0.5 for everything.
    direct_by_id = {d.id: d for d in network.direct_paths}
    for d_id in index.direct_ids:
        x0[index.direct_col[d_id]] = direct_by_id[d_id].confidence
    for leg_id in index.leg_ids:
        x0[index.leg_col[leg_id]] = network.half_legs[leg_id].confidence
    for p_id in index.point_ids:
        group = network.point_groups[p_id]
        confidences = [network.half_legs[leg_id].confidence for leg_id in group.half_leg_ids]
        x0[index.point_bool_col[p_id]] = sum(confidences) / len(confidences) if confidences else 0.0
        # The natural point (from the parallelogram decomposition, see
        # path_network.py) can genuinely fall outside [0,1] -- clip the
        # seed into the now-bounded domain rather than handing scipy an
        # infeasible starting point for it to silently clip itself.
        px, py = group.natural_point
        c = index.point_xy_col[p_id]
        x0[c] = min(1.0, max(0.0, px))
        x0[c + 1] = min(1.0, max(0.0, py))
    return x0


def _position_gradient_contribution(
    plan: VariablePlan, leaf_id: str, dpx: float, dpy: float, grad: np.ndarray, symmetry_mode: SymmetryMode
) -> None:
    """Adds d(objective)/d(x) for every column that `leaf_id`'s position
    actually depends on, given the upstream sensitivities d(objective)/dpx,
    d(objective)/dpy -- chaining through whichever of VariablePlan's linear
    decode formulas applies to this leaf's spec kind. A pair follower has no
    columns of its own; its sensitivity redirects into its leader's columns
    via the same reflection VariablePlan.decode uses to derive its position."""
    spec = plan.specs[leaf_id]
    if spec.kind == "free":
        grad[spec.var_start] += dpx
        grad[spec.var_start + 1] += dpy
    elif spec.kind == "symmetry_free":
        if symmetry_mode == SymmetryMode.BOOK:
            grad[spec.var_start] += dpy
        else:
            grad[spec.var_start] += dpx + dpy
    elif spec.kind == "edge_free":
        if spec.edge in ("left", "right"):
            grad[spec.var_start] += dpy
        else:
            grad[spec.var_start] += dpx
    elif spec.kind == "pair_secondary":
        if symmetry_mode == SymmetryMode.BOOK:
            _position_gradient_contribution(plan, spec.paired_with, -dpx, dpy, grad, symmetry_mode)
        else:
            _position_gradient_contribution(plan, spec.paired_with, dpy, dpx, grad, symmetry_mode)
    # corner_fixed / resolved_fixed / locked_fixed leaves have no columns.


def build_objective(
    index: PathNetworkVariableIndex,
    initial_positions: Dict[str, Tuple[float, float]],
    initial_lengths: Dict[str, float],
    count_weight: float,
    c1: float,
    c2: float,
    c3: float,
    symmetry_mode: SymmetryMode,
    annealing_weight: float,
) -> Callable[[np.ndarray], Tuple[float, np.ndarray]]:
    """The primary signal is now a plain count: maximize the number of
    selected direct paths plus the number of active (degree>=3) point
    groups, each counted once regardless of how many legs it has. This
    replaces CWKS-matching as the primary objective -- CWKS was found to be
    fighting the solver rather than guiding it, and the count-based signal
    is what "as many paths/vertices as possible" literally means. The CWKS
    machinery itself (app/core/spectral.py) is untouched and can be wired
    back in later; this function simply no longer calls it. Minimizing
    `-count_weight * count` is what "maximize count" means for a solver
    that minimizes its objective."""
    s0 = sum(initial_lengths[e] for e in index.length_ids)
    l0hat = {e: initial_lengths[e] / s0 for e in index.length_ids}

    def value_and_grad(x: np.ndarray) -> Tuple[float, np.ndarray]:
        positions = index.decode_positions(x)
        lengths = index.decode_lengths(x)
        grad = np.zeros_like(x)

        total = 0.0
        for col in index.direct_col.values():
            total += -count_weight * x[col]
            grad[col] += -count_weight
        for col in index.point_bool_col.values():
            total += -count_weight * x[col]
            grad[col] += -count_weight

        c1_total = 0.0
        for leaf_id in index.plan.leaf_ids:
            px, py = positions[leaf_id]
            px0, py0 = initial_positions[leaf_id]
            weight = c1 * l0hat[leaf_id] ** 2
            dx, dy = px - px0, py - py0
            c1_total += weight * (dx * dx + dy * dy)
            _position_gradient_contribution(index.plan, leaf_id, 2 * weight * dx, 2 * weight * dy, grad, symmetry_mode)
        total += c1_total

        # Saturating (tanh) form, not the naive linear -C2*(Lhat-L0hat)*L0hat:
        # that linear form's maximized quantity (Sum Lhat*L0hat) keeps
        # increasing as any one edge's Lhat approaches 1 with no penalty
        # ever pushing back, which combined with lengths having no other
        # constraint (see path_network.py's far_pairs fix) let a length run
        # away chasing that asymptote. tanh saturates each edge's own
        # contribution at +/-L0hat_e, so the reward/penalty stops growing
        # once a length has already deviated a couple multiples of its own
        # initial share -- bounded regardless of what else is going on.
        s = sum(lengths[e] for e in index.length_ids)
        lhat = {e: lengths[e] / s for e in index.length_ids}
        u = {e: (lhat[e] - l0hat[e]) / max(l0hat[e], 1e-9) for e in index.length_ids}
        tanh_u = {e: math.tanh(u[e]) for e in index.length_ids}
        sech2_u = {e: 1.0 - tanh_u[e] ** 2 for e in index.length_ids}
        c2_total = -c2 * sum(l0hat[e] * tanh_u[e] for e in index.length_ids)
        total += c2_total
        k2_const = sum(sech2_u[e] * lhat[e] for e in index.length_ids)
        for e in index.length_ids:
            grad[index.length_col[e]] += -c2 / s * (sech2_u[e] - k2_const)

        c3_total = 0.0
        for p_id in index.point_ids:
            a_val = x[index.point_bool_col[p_id]]
            c3_total += c3 * a_val
            grad[index.point_bool_col[p_id]] += c3
        total += c3_total

        anneal_total = 0.0
        for col in index.all_boolean_cols():
            b = x[col]
            anneal_total += annealing_weight * b * (1 - b)
            grad[col] += annealing_weight * (1 - 2 * b)
        total += anneal_total

        return total, grad

    return value_and_grad


def _resolve_bool_col(index: PathNetworkVariableIndex, var_id: str) -> int:
    if var_id in index.direct_col:
        return index.direct_col[var_id]
    return index.leg_col[var_id]


def build_constraints(
    index: PathNetworkVariableIndex,
    network: PathNetworkPreprocessing,
    tree: nx.DiGraph,
    scale: float,
    alpha: float,
    bases: Optional[Sequence[Tuple[float, float]]],
    equal_pairs: Dict[str, str],
    m_angle: float = BIG_M,
    m_length: float = BIG_M,
) -> List[dict]:
    """`m_angle`/`m_length` are the big-M slacks for the angle- and length-
    gated constraints respectively -- kept separate (and, per
    path_network_solve.py's anneal schedule, shrunk independently) because
    an off-angle crease is a worse defect than a slightly-off length, so
    angle deserves less slack even mid-relaxation."""
    constraints: List[dict] = []

    def add_ineq(fn: Callable[[np.ndarray], float]) -> None:
        constraints.append({"type": "ineq", "fun": fn})

    def add_eq(fn: Callable[[np.ndarray], float]) -> None:
        constraints.append({"type": "eq", "fun": fn})

    for direct in network.direct_paths:
        n_hat = (-math.sin(direct.angle), math.cos(direct.angle))
        d_hat = (math.cos(direct.angle), math.sin(direct.angle))
        edges_on_path = path_edge_ids(tree, direct.a, direct.b)
        b_col = index.direct_col[direct.id]

        def make_angle(sign: float, a=direct.a, b=direct.b, n_hat=n_hat, b_col=b_col):
            def fn(x: np.ndarray) -> float:
                positions = index.decode_positions(x)
                pa, pb = positions[a], positions[b]
                val = n_hat[0] * (pb[0] - pa[0]) + n_hat[1] * (pb[1] - pa[1])
                return m_angle * (1 - x[b_col]) + sign * val

            return fn

        add_ineq(make_angle(-1.0))
        add_ineq(make_angle(1.0))

        def make_length(sign: float, a=direct.a, b=direct.b, d_hat=d_hat, b_col=b_col, edges=edges_on_path):
            def fn(x: np.ndarray) -> float:
                positions = index.decode_positions(x)
                pa, pb = positions[a], positions[b]
                lengths = index.decode_lengths(x)
                proj = d_hat[0] * (pb[0] - pa[0]) + d_hat[1] * (pb[1] - pa[1])
                target = scale * sum(lengths[e] for e in edges)
                return m_length * (1 - x[b_col]) + sign * (proj - target)

            return fn

        add_ineq(make_length(-1.0))
        add_ineq(make_length(1.0))

    for leg in network.half_legs.values():
        n_hat = (-math.sin(leg.angle), math.cos(leg.angle))
        leg_col = index.leg_col[leg.id]
        px_col, py_col = index.point_xy_col[leg.point_group_id], index.point_xy_col[leg.point_group_id] + 1

        def make_leg_angle(sign: float, flap=leg.flap, n_hat=n_hat, leg_col=leg_col, px_col=px_col, py_col=py_col):
            def fn(x: np.ndarray) -> float:
                positions = index.decode_positions(x)
                pf = positions[flap]
                val = n_hat[0] * (x[px_col] - pf[0]) + n_hat[1] * (x[py_col] - pf[1])
                return m_angle * (1 - x[leg_col]) + sign * val

            return fn

        add_ineq(make_leg_angle(-1.0))
        add_ineq(make_leg_angle(1.0))

    for candidate in network.indirect_paths:
        leg_a = network.half_legs[candidate.leg_a_id]
        leg_b = network.half_legs[candidate.leg_b_id]
        d_hat_a = (math.cos(leg_a.angle), math.sin(leg_a.angle))
        d_hat_b = (math.cos(leg_b.angle), math.sin(leg_b.angle))
        col_a, col_b = index.leg_col[leg_a.id], index.leg_col[leg_b.id]
        pxa, pya = index.point_xy_col[leg_a.point_group_id], index.point_xy_col[leg_a.point_group_id] + 1
        pxb, pyb = index.point_xy_col[leg_b.point_group_id], index.point_xy_col[leg_b.point_group_id] + 1
        target = candidate.target_distance

        def make_indirect_length(
            sign: float,
            a=candidate.a,
            b=candidate.b,
            d_hat_a=d_hat_a,
            d_hat_b=d_hat_b,
            col_a=col_a,
            col_b=col_b,
            pxa=pxa,
            pya=pya,
            pxb=pxb,
            pyb=pyb,
            target=target,
        ):
            def fn(x: np.ndarray) -> float:
                positions = index.decode_positions(x)
                pa, pb = positions[a], positions[b]
                len_a = d_hat_a[0] * (x[pxa] - pa[0]) + d_hat_a[1] * (x[pya] - pa[1])
                len_b = d_hat_b[0] * (x[pxb] - pb[0]) + d_hat_b[1] * (x[pyb] - pb[1])
                slack = m_length * ((1 - x[col_a]) + (1 - x[col_b]))
                return slack + sign * (len_a + len_b - scale * target)

            return fn

        add_ineq(make_indirect_length(-1.0))
        add_ineq(make_indirect_length(1.0))

    for id1, id2 in network.nand_pairs:
        col1, col2 = _resolve_bool_col(index, id1), _resolve_bool_col(index, id2)

        def make_nand(col1=col1, col2=col2):
            def fn(x: np.ndarray) -> float:
                return 1.0 - x[col1] - x[col2]

            return fn

        add_ineq(make_nand())

    for group in network.point_groups.values():
        leg_cols = [index.leg_col[leg_id] for leg_id in group.half_leg_ids]
        a_col = index.point_bool_col[group.id]
        size = len(leg_cols)

        # A point group's leg count must be 0 or >= MIN_VERTEX_DEGREE (3),
        # never in between -- a 2-leg "point" is just a kink, not a genuine
        # junction (see path_network.py's module docstring).
        def make_lower(leg_cols=leg_cols, a_col=a_col):
            def fn(x: np.ndarray) -> float:
                return float(sum(x[c] for c in leg_cols)) - MIN_VERTEX_DEGREE * x[a_col]

            return fn

        def make_upper(leg_cols=leg_cols, a_col=a_col, size=size):
            def fn(x: np.ndarray) -> float:
                return size * x[a_col] - float(sum(x[c] for c in leg_cols))

            return fn

        add_ineq(make_lower())
        add_ineq(make_upper())

    for a, b in network.overlap_pairs:
        dist = find_distance(tree, a, b)

        def make_overlap(a=a, b=b, dist=dist):
            def fn(x: np.ndarray) -> float:
                positions = index.decode_positions(x)
                dx = positions[a][0] - positions[b][0]
                dy = positions[a][1] - positions[b][1]
                if bases is None:
                    val = math.hypot(dx, dy)
                else:
                    projections = [dx * bx + dy * by for bx, by in bases]
                    val = smooth_max(projections, alpha)
                return val - scale * dist

            return fn

        add_ineq(make_overlap())

    # Far pairs skip the expensive separating-axis check, but still get a
    # cheap raw-distance floor -- satisfying the exact polygon-SAT
    # constraint above always implies this (Cauchy-Schwarz bounds every
    # basis projection by the raw distance), so this can never bind for a
    # pair that already has the real check; its only job is to stop a
    # length whose every pair got pruned from growing with nothing at all
    # holding it back.
    for a, b in network.far_pairs:
        dist = find_distance(tree, a, b)

        def make_far(a=a, b=b, dist=dist):
            def fn(x: np.ndarray) -> float:
                positions = index.decode_positions(x)
                dx = positions[a][0] - positions[b][0]
                dy = positions[a][1] - positions[b][1]
                return math.hypot(dx, dy) - scale * dist

            return fn

        add_ineq(make_far())

    seen: set = set()
    for a, b in equal_pairs.items():
        if a in seen or b in seen:
            continue
        seen.add(a)
        seen.add(b)
        if a not in index.length_col or b not in index.length_col:
            continue

        def make_equal(a=a, b=b):
            def fn(x: np.ndarray) -> float:
                return x[index.length_col[a]] - x[index.length_col[b]]

            return fn

        add_eq(make_equal())

    return constraints
