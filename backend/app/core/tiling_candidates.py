"""Candidate enumeration for the tiling solver: every direct flap-to-flap
path, every structural point-group of half-legs, every free two-leg bend, and
the full per-`(flap, direction-bin)` slot occupancy map -- everything
`tiling_solve.py`'s MILP candidate-selection step (slot exclusivity +
per-flap angular-coverage/concavity constraints) and its convex-hull
auto-pinning need, with no knowledge of rows/rank/least-squares/MILP itself.

Structurally mirrors `path_network.py`'s direct-path detection and its
two-configuration parallelogram decomposition for indirect legs, and its
leg-identity + union-find point-group clustering (every raw leg is keyed
purely by `(flap, direction-bin)` -- never by position/proximity, since a ray
is already fully determined by its flap and its committed direction; two
different candidates sharing a leg transitively merge their points into one,
exactly the "shared direction forms a triplet" mechanism). Differs from
`path_network.py` in three ways, per the tiling redesign:

- No `confidence`/length-ratio scoring -- perturbation heuristics are
  computed fresh here directly from the *current* layout (see
  `_direct_heuristic`/`_point_group_heuristic`), not from a tangency-ratio
  score, since lengths are no longer part of what this solver enforces.
- No `overlap_pairs`/`far_pairs` -- this design doesn't avoid overlaps at
  all ("don't worry about the tiling causing overlaps").
- A point group that can't reach `MIN_VERTEX_DEGREE` (3) legs is kept as a
  `TwoLegBend` fallback candidate, not replaced with a direct-path candidate
  -- a 2-leg bend point is always exactly satisfiable (the intersection of
  its 2 legs' lines) with zero effect on flap positions, so it costs nothing
  to keep in reserve for flaps that can't otherwise reach full angular
  coverage through real (row-contributing) candidates alone.

`flap_bins`/`n_bins`/`offset_angle`/`period` (added for the MILP-based
concavity redesign) expose exactly the slot structure `tiling_solve.py` needs
to build both the slot-exclusivity ("at most one candidate per physical
direction") and angular-coverage ("no sector of `>= 180` degrees with nothing
selected") constraints, without re-deriving the shape's bin geometry itself.
"""

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

import networkx as nx
import numpy as np
from scipy.spatial import ConvexHull, QhullError

from app.core.shapes import get_bases
from app.core.tree import find_distance

MIN_VERTEX_DEGREE = 3


@dataclass
class DirectPathCandidate:
    id: str
    a: str
    b: str
    angle: float  # snapped direction from a to b


@dataclass
class HalfLeg:
    id: str
    flap: str
    angle: float
    point_group_id: str


@dataclass
class PointGroup:
    id: str
    half_leg_ids: List[str] = field(default_factory=list)


@dataclass
class TwoLegBend:
    """A doomed (<3-leg) point group, kept as a free fallback: its point is
    always exactly the intersection of its two legs' lines, with zero effect
    on flap positions -- it never appears in the constraint matrix."""

    id: str
    a: str
    b: str
    angle_a: float
    angle_b: float


@dataclass
class TilingCandidates:
    direct_paths: List[DirectPathCandidate]
    point_groups: Dict[str, PointGroup]
    half_legs: Dict[str, HalfLeg]
    two_leg_bends: List[TwoLegBend]
    # Perturbation heuristic for every direct path and point group (by id) --
    # used as the MILP's per-candidate objective cost. Not defined for
    # two_leg_bends, which are free and never MILP variables.
    heuristics: Dict[str, float]
    # (flap, direction-bin index) -> every candidate id (direct/point-group/
    # bend) that occupies that physical slot. A flap's own bin geometry is
    # shared by every flap (same shape), given by n_bins/offset_angle/period.
    flap_bins: Dict[Tuple[str, int], List[str]]
    n_bins: int
    offset_angle: float
    period: float
    hull_flap_ids: Set[str]


class _UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def _bin_index(angle: float, offset_angle: float, period: float, n: int) -> int:
    return round((angle - offset_angle) / period) % n


def line_intersection(
    p1: Tuple[float, float], theta1: float, p2: Tuple[float, float], theta2: float
) -> Optional[Tuple[float, float]]:
    d1 = (math.cos(theta1), math.sin(theta1))
    d2 = (math.cos(theta2), math.sin(theta2))
    det = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(det) < 1e-9:
        return None
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    t = (dx * d2[1] - dy * d2[0]) / det
    return (p1[0] + t * d1[0], p1[1] + t * d1[1])


def _convex_hull_flap_ids(ids: List[str], positions: Dict[str, Tuple[float, float]]) -> Set[str]:
    """Every flap on the convex hull of the current packing -- these are
    exempt from the interior degree>=2 rule and are candidates for the
    nearest-boundary auto-pin. Degenerate input (fewer than 3 flaps, or all
    collinear) has no well-defined interior, so every flap counts as a hull
    flap defensively."""
    if len(ids) < 3:
        return set(ids)
    pts = np.array([positions[i] for i in ids])
    try:
        hull = ConvexHull(pts)
    except QhullError:
        return set(ids)
    return {ids[i] for i in hull.vertices}


def _direct_heuristic(a: str, b: str, positions: Dict[str, Tuple[float, float]], angle: float) -> float:
    """The magnitude of the current path's displacement component
    perpendicular to its snapped direction -- how far this pair already is
    from lying exactly on that line."""
    pa, pb = positions[a], positions[b]
    n_hat = (-math.sin(angle), math.cos(angle))
    dx, dy = pb[0] - pa[0], pb[1] - pa[1]
    return abs(n_hat[0] * dx + n_hat[1] * dy)


def _point_group_heuristic(
    group: PointGroup, half_legs: Dict[str, HalfLeg], positions: Dict[str, Tuple[float, float]]
) -> float:
    """The geometric analogue of the direct-path residual, generalized to k
    legs at once: fit the single point that best satisfies every leg's line
    equation `n_hat_i . (X - F_i) = 0` in a least-squares sense (using the
    *current* flap positions), then take the RMS residual across all k lines
    at that fit point. If the group were already exactly concurrent, every
    residual would be 0 -- same units (world length) as the direct-path
    heuristic, so both sort into one combined queue.

    Unlike an approach based on pairwise line intersections, this needs no
    special-casing when two of the group's legs happen to share the same
    direction (a real, common case -- e.g. two different bend candidates'
    "far" legs both snapping to the same octagon bin): least squares handles
    a redundant/near-parallel pair of rows gracefully on its own."""
    legs = [half_legs[leg_id] for leg_id in group.half_leg_ids]
    m = np.array([[-math.sin(leg.angle), math.cos(leg.angle)] for leg in legs])
    d = np.array([m[i, 0] * positions[legs[i].flap][0] + m[i, 1] * positions[legs[i].flap][1] for i in range(len(legs))])
    point, _, _, _ = np.linalg.lstsq(m, d, rcond=None)
    residuals = m @ point - d
    return float(np.sqrt(np.mean(residuals**2)))


def enumerate_tiling_candidates(
    tree: nx.DiGraph,
    leaf_ids: List[str],
    positions: Dict[str, Tuple[float, float]],
    scale: float,
    shape: str,
    symmetry_mode: str,
    extra_rotation: bool,
    length_tolerance: float,
    angle_tolerance_degrees: float,
) -> Optional[TilingCandidates]:
    bases = get_bases(shape, symmetry_mode, extra_rotation)
    if bases is None:
        return None

    n = len(bases)
    period = 2 * math.pi / n
    offset_angle = math.atan2(bases[0][1], bases[0][0])
    angle_tolerance = math.radians(angle_tolerance_degrees)

    ids = [leaf_id for leaf_id in leaf_ids if leaf_id in positions]

    direct_paths: List[DirectPathCandidate] = []
    # Each entry: (flap, angle, candidate_index, "a1"/"b1"/"a2"/"b2")
    raw_refs: List[Tuple[str, float, int, str]] = []
    pending_count = 0

    def add_direct(a: str, b: str, angle: float) -> None:
        direct_paths.append(DirectPathCandidate(id=f"direct::{a}::{b}", a=a, b=b, angle=angle))

    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = ids[i], ids[j]
            pa, pb = positions[a], positions[b]
            dx, dy = pb[0] - pa[0], pb[1] - pa[1]
            dist = math.hypot(dx, dy)
            required = scale * find_distance(tree, a, b)
            if required <= 0:
                continue
            ratio = dist / required
            if abs(ratio - 1) > length_tolerance:
                continue

            theta = math.atan2(dy, dx)
            k = round((theta - offset_angle) / period)
            nearest = offset_angle + k * period
            rel = theta - nearest

            if abs(rel) <= angle_tolerance:
                add_direct(a, b, nearest)
                continue

            theta_lo = nearest
            theta_hi = nearest + math.copysign(period, rel)
            u1 = (math.cos(theta_lo), math.sin(theta_lo))
            u2 = (math.cos(theta_hi), math.sin(theta_hi))
            det = u1[0] * u2[1] - u1[1] * u2[0]
            if abs(det) < 1e-9:
                add_direct(a, b, nearest)
                continue
            coeff_a = (dx * u2[1] - dy * u2[0]) / det
            coeff_b = (dy * u1[0] - dx * u1[1]) / det

            candidate_idx = pending_count
            pending_count += 1

            leg_a1_angle = theta_lo if coeff_a >= 0 else theta_lo + math.pi
            leg_b1_angle = (theta_hi + math.pi) if coeff_b >= 0 else theta_hi
            leg_a2_angle = theta_hi if coeff_b >= 0 else theta_hi + math.pi
            leg_b2_angle = (theta_lo + math.pi) if coeff_a >= 0 else theta_lo

            raw_refs.append((a, leg_a1_angle, candidate_idx, "a1"))
            raw_refs.append((b, leg_b1_angle, candidate_idx, "b1"))
            raw_refs.append((a, leg_a2_angle, candidate_idx, "a2"))
            raw_refs.append((b, leg_b2_angle, candidate_idx, "b2"))

    # --- Leg identity: every raw ref at the same (flap, direction-bin) is the
    # same physical leg -- no proximity check (see module docstring).
    slot_to_leg_id: Dict[Tuple[str, int], str] = {}
    ref_to_leg_id: Dict[int, str] = {}
    half_legs_all: Dict[str, HalfLeg] = {}
    leg_counter = 0
    for idx, (flap, angle, _cand, _role) in enumerate(raw_refs):
        key = (flap, _bin_index(angle, offset_angle, period, n))
        leg_id = slot_to_leg_id.get(key)
        if leg_id is None:
            leg_id = f"leg::{flap}::{leg_counter}"
            leg_counter += 1
            slot_to_leg_id[key] = leg_id
            half_legs_all[leg_id] = HalfLeg(id=leg_id, flap=flap, angle=angle, point_group_id="")
        ref_to_leg_id[idx] = leg_id

    # --- Point-group clustering: union-find over LEG IDS. Each candidate
    # unions its own a1<->b1 and (separately) a2<->b2 -- two independent bend
    # configurations, each forming its own point unless further leg-sharing
    # merges them with other candidates' points.
    leg_ids_ordered = list(half_legs_all.keys())
    leg_index = {leg_id: i for i, leg_id in enumerate(leg_ids_ordered)}
    uf_points = _UnionFind(len(leg_ids_ordered))
    # Grouped by candidate in a single pass over `raw_refs` instead of the
    # O(pending_count) re-scans of the whole (4x-larger) list this used to
    # do per candidate (O(pending_count^2) overall, ~O(leaves^4) worst case
    # since pending_count is O(leaves^2)) -- same groups either way, since
    # every candidate's 4 refs are already tagged with their own index.
    refs_by_candidate: Dict[int, Dict[str, str]] = {}
    for global_idx, (flap, angle, cand, role) in enumerate(raw_refs):
        refs_by_candidate.setdefault(cand, {})[role] = ref_to_leg_id[global_idx]
    for candidate_idx in range(pending_count):
        refs_for_candidate = refs_by_candidate[candidate_idx]
        uf_points.union(leg_index[refs_for_candidate["a1"]], leg_index[refs_for_candidate["b1"]])
        uf_points.union(leg_index[refs_for_candidate["a2"]], leg_index[refs_for_candidate["b2"]])

    groups_by_root: Dict[int, List[str]] = {}
    for local_i, leg_id in enumerate(leg_ids_ordered):
        root = uf_points.find(local_i)
        groups_by_root.setdefault(root, []).append(leg_id)

    point_groups: Dict[str, PointGroup] = {}
    two_leg_bends: List[TwoLegBend] = []
    half_legs: Dict[str, HalfLeg] = {}
    id_counter = 0
    for member_ids in groups_by_root.values():
        if len(member_ids) >= MIN_VERTEX_DEGREE:
            group_id = f"point::{id_counter}"
            id_counter += 1
            for leg_id in member_ids:
                half_legs_all[leg_id].point_group_id = group_id
                half_legs[leg_id] = half_legs_all[leg_id]
            point_groups[group_id] = PointGroup(id=group_id, half_leg_ids=list(member_ids))
        else:
            # Every leg is unioned with exactly one partner at minimum (see
            # module docstring), so a group here always has exactly 2 members.
            leg1, leg2 = half_legs_all[member_ids[0]], half_legs_all[member_ids[1]]
            bend_id = f"bend::{id_counter}"
            id_counter += 1
            two_leg_bends.append(TwoLegBend(id=bend_id, a=leg1.flap, b=leg2.flap, angle_a=leg1.angle, angle_b=leg2.angle))

    heuristics: Dict[str, float] = {}
    for direct in direct_paths:
        heuristics[direct.id] = _direct_heuristic(direct.a, direct.b, positions, direct.angle)
    for group in point_groups.values():
        heuristics[group.id] = _point_group_heuristic(group, half_legs, positions)

    # --- Slot occupancy: every candidate (direct, point-group, or bend)
    # tagged onto every (flap, direction-bin) slot it uses. Doubles as both
    # the "at most one candidate per slot" (NAND) and the angular-coverage
    # window inputs in tiling_solve.py.
    flap_bins: Dict[Tuple[str, int], List[str]] = {}

    def add_slot(flap: str, angle: float, candidate_id: str) -> None:
        key = (flap, _bin_index(angle, offset_angle, period, n))
        flap_bins.setdefault(key, []).append(candidate_id)

    for direct in direct_paths:
        add_slot(direct.a, direct.angle, direct.id)
        add_slot(direct.b, direct.angle + math.pi, direct.id)
    for group in point_groups.values():
        for leg_id in group.half_leg_ids:
            leg = half_legs[leg_id]
            add_slot(leg.flap, leg.angle, group.id)
    for bend in two_leg_bends:
        add_slot(bend.a, bend.angle_a, bend.id)
        add_slot(bend.b, bend.angle_b, bend.id)

    hull_flap_ids = _convex_hull_flap_ids(ids, positions)

    return TilingCandidates(
        direct_paths=direct_paths,
        point_groups=point_groups,
        half_legs=half_legs,
        two_leg_bends=two_leg_bends,
        heuristics=heuristics,
        flap_bins=flap_bins,
        n_bins=n,
        offset_angle=offset_angle,
        period=period,
        hull_flap_ids=hull_flap_ids,
    )
