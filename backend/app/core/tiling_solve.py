"""Candidate selection + row assembly for the tiling solver.

Order of operations: base rows from user constraints (locked/boundary/
symmetry/pairing, see `tiling_rows.build_base_rows`), then convex-hull
auto-pinning (derived, so routed through the rank-checked accept/reject path
rather than added unconditionally), then a MILP that picks the min-cost
subset of direct-path/point-group candidates satisfying, at every flap, both
slot exclusivity (a flap can't have two creases in the same physical
direction) and angular coverage (no gap of >=180 degrees between selected
directions on a flap's non-paper-boundary-facing side -- a concave/reflex
polygon vertex), then a free two-leg-bend fallback phase patching any
still-uncovered gaps, then the final minimum-perturbation least-squares
solve.

Why a MILP (and not the originally-planned rank-checked greedy walk, or an
SMT solver): once "no candidate touching only already-satisfied flaps should
ever be picked" became "no flap may end up with a >=180 degree gap between
its selected directions," selection stopped being a simple incremental
connectivity fill and became a genuine constrained optimization -- minimize
total perturbation cost subject to per-flap linear coverage/exclusivity
constraints over boolean candidate variables. That is exactly the textbook
shape of a binary set-cover/set-packing MILP, and `scipy.optimize.milp`
(HiGHS) already ships with this project's pinned scipy version -- no new
dependency. An SMT solver is built for satisfiability under an open-ended
theory, not for minimizing a linear objective; where SMT solvers do bolt on
optimization it's generally weaker at pure linear-objective minimization
than a dedicated MILP branch-and-bound/cut solver, for no expressiveness
this problem actually needs.

The row-based least-squares *position* solve (`tiling_rows.py`) is
unaffected by the MILP addition: every MILP-selected candidate's rows are
added to `A` unconditionally (no rank check, per the same "assume
overconstraint won't be an issue" scope as the original design) --
`solve_min_perturbation`'s `lstsq`-based solve already degrades gracefully
(minimum-norm among exact solutions, or best-fit approximate) if `A` ever
ends up rank-deficient or mildly inconsistent, so nothing there needed to
change.
"""

import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp

from app.core.constraint_resolution import corner_position
from app.core.tiling_candidates import (
    DirectPathCandidate,
    HalfLeg,
    PointGroup,
    TilingCandidates,
    TwoLegBend,
    line_intersection,
)
from app.core.tiling_rows import Row, build_base_rows, solve_min_perturbation, try_accept
from app.schemas.constraints import Constraints

# The strict "<180 degrees" concavity mode -- every cyclic window of this
# many consecutive direction-bins must contain at least one selected
# direction. A future advanced setting can relax this to `n_bins // 2`
# (allowing a gap of exactly 180 degrees) by passing strict=False through to
# `_select_candidates_via_milp`/`_fill_remaining_gaps_with_bends` -- not
# wired up to a hyperparameter yet.
_EDGE_OUTWARD_ANGLE = {"left": math.pi, "right": 0.0, "top": math.pi / 2, "bottom": -math.pi / 2}


@dataclass
class TilingVertex:
    id: str
    x: float
    y: float
    legs: List[Tuple[str, float]]  # (flap, angle) pairs meeting at this vertex


@dataclass
class TilingSolveResult:
    leaf_positions: Dict[str, Tuple[float, float]]
    selected_direct_paths: List[DirectPathCandidate]
    vertices: List[TilingVertex]


def _direct_row(direct: DirectPathCandidate) -> Row:
    n_hat = (-math.sin(direct.angle), math.cos(direct.angle))
    return Row(
        {
            (direct.b, "x"): n_hat[0],
            (direct.a, "x"): -n_hat[0],
            (direct.b, "y"): n_hat[1],
            (direct.a, "y"): -n_hat[1],
        },
        0.0,
    )


def _concurrency_row(l0: HalfLeg, l1: HalfLeg, l2: HalfLeg) -> Row:
    """The 3-line-concurrency row for legs l0, l1, l2 -- derived from the
    determinant condition `det[[a_k,b_k,c_k]] = 0` for lines `a_k*X+b_k*Y=c_k`
    with `a_k=-sin(theta_k)`, `b_k=cos(theta_k)`, `c_k=a_k*x_k+b_k*y_k`.
    Expanding along the c-column gives `w0*c0 + w1*c1 + w2*c2 = 0` with
    `w0=sin(t2-t1)`, `w1=sin(t0-t2)`, `w2=sin(t1-t0)` -- substituting each
    `c_k` back in terms of (x_k, y_k) yields one linear equation over exactly
    the 3 flaps' 6 coordinates."""
    legs = (l0, l1, l2)
    thetas = [leg.angle for leg in legs]
    a = [-math.sin(t) for t in thetas]
    b = [math.cos(t) for t in thetas]
    w = [
        math.sin(thetas[2] - thetas[1]),
        math.sin(thetas[0] - thetas[2]),
        math.sin(thetas[1] - thetas[0]),
    ]
    coeffs: Dict[Tuple[str, str], float] = {}
    for k in range(3):
        flap = legs[k].flap
        coeffs[(flap, "x")] = coeffs.get((flap, "x"), 0.0) + w[k] * a[k]
        coeffs[(flap, "y")] = coeffs.get((flap, "y"), 0.0) + w[k] * b[k]
    return Row(coeffs, 0.0)


def _find_nonparallel_pair(legs: List[HalfLeg]) -> Optional[Tuple[int, int]]:
    """Two legs sharing a direction (e.g. two different bend candidates' far
    legs both snapping to the same octagon bin -- a common, valid case, not
    a rare edge case) can't anchor a concurrency row: their own two lines
    never meet at a finite point unless they're literally the same line, so
    the determinant derivation degenerates. Any OTHER pair in the group is
    generally fine, so search for one instead of assuming legs[0]/legs[1]."""
    for i in range(len(legs)):
        for j in range(i + 1, len(legs)):
            d1 = (math.cos(legs[i].angle), math.sin(legs[i].angle))
            d2 = (math.cos(legs[j].angle), math.sin(legs[j].angle))
            if abs(d1[0] * d2[1] - d1[1] * d2[0]) > 1e-9:
                return i, j
    return None


def _point_group_rows(group: PointGroup, half_legs: Dict[str, HalfLeg]) -> List[Row]:
    """The k-2 concurrency rows for a k-leg point group: anchor on any two
    mutually non-parallel legs, and add one row tying each additional leg
    into the same concurrency condition. Returns no rows at all if every leg
    in the group shares the same direction (fully degenerate -- left
    unresolved by this mechanism rather than emitting a row that can't mean
    what it's supposed to); such a group can still be MILP-selected purely
    for its angular-coverage value, contributing zero rows, same as a
    two-leg bend."""
    legs = [half_legs[leg_id] for leg_id in group.half_leg_ids]
    anchor = _find_nonparallel_pair(legs)
    if anchor is None:
        return []
    i0, i1 = anchor
    l0, l1 = legs[i0], legs[i1]
    others = [leg for idx, leg in enumerate(legs) if idx not in (i0, i1)]
    return [_concurrency_row(l0, l1, leg) for leg in others]


def _nearest_edge(position: Tuple[float, float]) -> str:
    x, y = position
    distances = {"left": x, "right": 1.0 - x, "bottom": y, "top": 1.0 - y}
    return min(distances, key=distances.get)


def _nearest_edge_row(flap: str, position: Tuple[float, float]) -> Row:
    edge = _nearest_edge(position)
    if edge == "left":
        return Row({(flap, "x"): 1.0}, 0.0)
    if edge == "right":
        return Row({(flap, "x"): 1.0}, 1.0)
    if edge == "bottom":
        return Row({(flap, "y"): 1.0}, 0.0)
    return Row({(flap, "y"): 1.0}, 1.0)


def _apply_hull_auto_pins(
    accepted_rows: List[Row],
    pos_col: Dict[str, int],
    hull_flap_ids: Set[str],
    positions: Dict[str, Tuple[float, float]],
    constraints: Constraints,
) -> None:
    """Pin every convex-hull flap to its nearest paper-square edge, skipping
    any flap the user already explicitly pinned (boundary or lock), and
    silently skipping any auto-pin that doesn't increase rank -- this is what
    safely no-ops an auto-pin that would conflict with e.g. a book-symmetry
    leaf already pinned in x (same coefficient row, different constant ->
    rank doesn't increase -> skipped, never raises)."""
    for flap in hull_flap_ids:
        constraint = constraints.per_leaf.get(flap)
        if constraint is not None and (constraint.boundary.kind != "none" or constraint.locked.kind != "none"):
            continue
        row = _nearest_edge_row(flap, positions[flap])
        if try_accept(accepted_rows, [row], pos_col):
            accepted_rows.append(row)


def _flap_exempt_arc(
    flap: str, position: Tuple[float, float], constraints: Constraints, hull_flap_ids: Set[str]
) -> Optional[Tuple[float, float]]:
    """The angular arc `(center, half_width)`, both in radians, on this
    flap's paper-boundary-facing side where a gap between selected
    directions is fine -- nothing needs to point off the edge of the paper
    there. `None` for a genuinely interior flap, where full 360-degree
    coverage is required. An explicit corner pin gets a wider exemption
    (270 degrees total) than an edge pin or a hull vertex's nearest-edge
    auto-pin (180 degrees total), per "the 180 degree sector angle on the
    outside of the square (or greater than 180 if it's a corner) is ok."""
    constraint = constraints.per_leaf.get(flap)
    if constraint is not None and constraint.boundary.kind == "pin_corner":
        cx, cy = corner_position(constraint.boundary.corner)
        dx = 1.0 if cx == 0.0 else -1.0
        dy = 1.0 if cy == 0.0 else -1.0
        required_center = math.atan2(dy, dx)
        return (required_center + math.pi, 3 * math.pi / 4)
    if constraint is not None and constraint.boundary.kind == "pin_edge":
        return (_EDGE_OUTWARD_ANGLE[constraint.boundary.edge], math.pi / 2)
    if flap in hull_flap_ids:
        return (_EDGE_OUTWARD_ANGLE[_nearest_edge(position)], math.pi / 2)
    return None


def _bin_is_exempt(bin_angle: float, arc: Optional[Tuple[float, float]]) -> bool:
    if arc is None:
        return False
    center, half_width = arc
    d = abs(((bin_angle - center + math.pi) % (2 * math.pi)) - math.pi)
    return d <= half_width + 1e-9


def _cyclic_windows(n_bins: int, window_size: int) -> List[List[int]]:
    return [[(start + k) % n_bins for k in range(window_size)] for start in range(n_bins)]


def _window_size(n_bins: int, strict: bool) -> int:
    return n_bins // 2 - (1 if strict else 0)


def _select_candidates_via_milp(
    leaf_ids: List[str],
    positions: Dict[str, Tuple[float, float]],
    constraints: Constraints,
    candidates: TilingCandidates,
    strict: bool = True,
) -> Set[str]:
    """The min-cost subset of direct-path/point-group candidates satisfying
    slot exclusivity and angular coverage at every flap -- see module
    docstring for why this is a MILP."""
    ordered_ids = [d.id for d in candidates.direct_paths] + list(candidates.point_groups.keys())
    if not ordered_ids:
        return set()
    var_index = {cid: i for i, cid in enumerate(ordered_ids)}
    n_vars = len(ordered_ids)
    cost = np.array([candidates.heuristics.get(cid, 0.0) for cid in ordered_ids])

    n_bins = candidates.n_bins
    windows = _cyclic_windows(n_bins, _window_size(n_bins, strict))

    rows: List[np.ndarray] = []
    lb: List[float] = []
    ub: List[float] = []

    # Slot exclusivity: at most one real candidate per (flap, bin) slot.
    for ids in candidates.flap_bins.values():
        real = [cid for cid in ids if cid in var_index]
        if len(real) <= 1:
            continue
        row = np.zeros(n_vars)
        for cid in real:
            row[var_index[cid]] = 1.0
        rows.append(row)
        lb.append(-np.inf)
        ub.append(1.0)

    # Angular coverage: every non-exempt window needs >=1 selected candidate.
    # A window no real candidate touches at all is structurally impossible to
    # satisfy -- dropped here rather than making the MILP infeasible, and
    # deferred entirely to the two-leg-bend fallback phase.
    for flap in leaf_ids:
        arc = _flap_exempt_arc(flap, positions[flap], constraints, candidates.hull_flap_ids)
        for window in windows:
            bin_angles = [candidates.offset_angle + b * candidates.period for b in window]
            if all(_bin_is_exempt(a, arc) for a in bin_angles):
                continue
            real_in_window: Set[str] = set()
            for b in window:
                for cid in candidates.flap_bins.get((flap, b), []):
                    if cid in var_index:
                        real_in_window.add(cid)
            if not real_in_window:
                continue
            row = np.zeros(n_vars)
            for cid in real_in_window:
                row[var_index[cid]] = 1.0
            rows.append(row)
            lb.append(1.0)
            ub.append(np.inf)

    bounds = Bounds(0, 1)
    integrality = np.ones(n_vars)
    if rows:
        constraint = LinearConstraint(np.vstack(rows), np.array(lb), np.array(ub))
        result = milp(cost, constraints=[constraint], integrality=integrality, bounds=bounds)
    else:
        result = milp(cost, integrality=integrality, bounds=bounds)

    if not result.success:
        # Assume-won't-happen escape hatch (per the concavity-constraint
        # addendum): degrade to selecting nothing rather than raising -- the
        # two-leg-bend fallback phase picks up whatever it structurally can.
        return set()

    return {cid for cid, i in var_index.items() if round(result.x[i]) == 1}


def _fill_remaining_gaps_with_bends(
    leaf_ids: List[str],
    positions: Dict[str, Tuple[float, float]],
    constraints: Constraints,
    candidates: TilingCandidates,
    selected_ids: Set[str],
    strict: bool = True,
) -> Set[str]:
    """For every flap/window still uncovered after the MILP, greedily use an
    available (not-yet-used, slot-free) two-leg-bend leg to patch it -- "if
    there are still not enough paths to choose from, resort to 2-legged
    indirect paths," strictly as a last resort. A window that can't be
    patched (no bend available for it) is simply left uncovered; deeper
    infeasibility recovery is out of scope for now, consistent with the
    structurally-impossible-window pre-filter in the MILP step above."""
    n_bins = candidates.n_bins
    windows = _cyclic_windows(n_bins, _window_size(n_bins, strict))
    bend_by_id = {bend.id: bend for bend in candidates.two_leg_bends}

    occupied: Set[Tuple[str, int]] = set()
    for (flap, b), ids in candidates.flap_bins.items():
        if any(cid in selected_ids for cid in ids):
            occupied.add((flap, b))

    used_bend_ids: Set[str] = set()

    def bend_other_end(bend: TwoLegBend, flap: str) -> Tuple[str, int]:
        if bend.a == flap:
            other_flap, other_angle = bend.b, bend.angle_b
        else:
            other_flap, other_angle = bend.a, bend.angle_a
        return other_flap, other_angle

    for flap in leaf_ids:
        arc = _flap_exempt_arc(flap, positions[flap], constraints, candidates.hull_flap_ids)
        for window in windows:
            bin_angles = [candidates.offset_angle + b * candidates.period for b in window]
            if all(_bin_is_exempt(a, arc) for a in bin_angles):
                continue
            if any((flap, b) in occupied for b in window):
                continue
            for b in window:
                patched = False
                for cid in candidates.flap_bins.get((flap, b), []):
                    bend = bend_by_id.get(cid)
                    if bend is None or cid in used_bend_ids:
                        continue
                    other_flap, other_angle = bend_other_end(bend, flap)
                    other_bin = round((other_angle - candidates.offset_angle) / candidates.period) % n_bins
                    if (flap, b) in occupied or (other_flap, other_bin) in occupied:
                        continue
                    used_bend_ids.add(cid)
                    occupied.add((flap, b))
                    occupied.add((other_flap, other_bin))
                    patched = True
                    break
                if patched:
                    break

    return used_bend_ids


def solve_tiling(
    leaf_ids: List[str],
    positions: Dict[str, Tuple[float, float]],
    constraints: Constraints,
    candidates: TilingCandidates,
) -> TilingSolveResult:
    pos_col = {leaf_id: 2 * i for i, leaf_id in enumerate(leaf_ids)}
    x0 = np.zeros(2 * len(leaf_ids))
    for leaf_id, col in pos_col.items():
        x0[col], x0[col + 1] = positions[leaf_id]

    accepted_rows: List[Row] = build_base_rows(leaf_ids, constraints)
    _apply_hull_auto_pins(accepted_rows, pos_col, candidates.hull_flap_ids, positions, constraints)

    direct_by_id = {d.id: d for d in candidates.direct_paths}
    group_by_id = candidates.point_groups
    half_legs = candidates.half_legs

    selected_ids = _select_candidates_via_milp(leaf_ids, positions, constraints, candidates)

    # Every MILP-selected candidate's rows are added unconditionally (no rank
    # check -- see module docstring).
    for cid in selected_ids:
        if cid in direct_by_id:
            accepted_rows.append(_direct_row(direct_by_id[cid]))
        else:
            accepted_rows.extend(_point_group_rows(group_by_id[cid], half_legs))

    used_bend_ids = _fill_remaining_gaps_with_bends(leaf_ids, positions, constraints, candidates, selected_ids)

    x_star = solve_min_perturbation(accepted_rows, pos_col, x0)
    leaf_positions: Dict[str, Tuple[float, float]] = {}
    for leaf_id, col in pos_col.items():
        leaf_positions[leaf_id] = (float(x_star[col]), float(x_star[col + 1]))

    selected_direct = [direct_by_id[cid] for cid in selected_ids if cid in direct_by_id]

    vertices: List[TilingVertex] = []
    for cid in selected_ids:
        if cid not in group_by_id:
            continue
        group = group_by_id[cid]
        legs = [half_legs[leg_id] for leg_id in group.half_leg_ids]
        anchor = _find_nonparallel_pair(legs)
        if anchor is not None:
            i0, i1 = anchor
            point = line_intersection(
                leaf_positions[legs[i0].flap], legs[i0].angle, leaf_positions[legs[i1].flap], legs[i1].angle
            )
        else:
            point = None
        if point is None:
            point = leaf_positions[legs[0].flap]
        vertices.append(TilingVertex(id=group.id, x=point[0], y=point[1], legs=[(leg.flap, leg.angle) for leg in legs]))

    for bend in candidates.two_leg_bends:
        if bend.id not in used_bend_ids:
            continue
        point = line_intersection(leaf_positions[bend.a], bend.angle_a, leaf_positions[bend.b], bend.angle_b)
        if point is None:
            point = leaf_positions[bend.a]
        vertices.append(
            TilingVertex(id=bend.id, x=point[0], y=point[1], legs=[(bend.a, bend.angle_a), (bend.b, bend.angle_b)])
        )

    return TilingSolveResult(leaf_positions=leaf_positions, selected_direct_paths=selected_direct, vertices=vertices)
