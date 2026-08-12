"""Preprocessing for the path-network snap solve: enumerates every candidate
direct path and indirect half-leg from the *current* layout (the same
tangency/angle test as active_paths.py), groups half-legs that terminate at a
shared intermediate point, records which candidates structurally compete for
the same physical direction, and prunes leaf pairs that are already far
enough apart to skip the non-overlap check entirely.

Design notes (see the confirmed formulation from the conversation this
implements):

- A "half-leg" is one flap's use of one shape-basis direction as part of one
  indirect (bent) connection to some other flap -- e.g. flap A's outgoing
  crease toward a bend point. Leg IDENTITY is purely structural: every raw
  candidate leg at the same (flap, direction-bin) is definitionally the same
  physical ray (a ray is just a point plus a direction, and the flap and the
  committed direction are already fixed), so they always collapse to one
  HalfLeg -- no distance/proximity check of any kind, since the leg's own
  endpoint is exactly what the solve is trying to determine, not something
  known in advance from the current (possibly wrong-topology) layout.
- Which half-legs share one intermediate point is *also* purely structural,
  not based on how close their naive endpoint guesses happen to be: every
  indirect candidate's own two legs (A-side and B-side) always union into
  one point (by construction, they're the two ends of the same bend). When a
  flap has two *different* indirect candidates that happen to commit to the
  same direction at that flap (hence -- see above -- the exact same physical
  leg), that shared leg transitively unions the two candidates' points into
  one: the shared leg plus the two candidates' respective far-side legs forms
  a triplet of legs around one intermediate point whose location is still
  entirely unknown (a free variable), not wherever either candidate's own
  naive p1/p2 estimate happened to land.
- Every ambiguous semi-active pair (A,B) -- one whose connecting angle isn't
  itself a valid direct-path angle -- produces *two* candidate bend
  configurations (bending near the "p1" vs the "p2" solution of the existing
  parallelogram decomposition; see geometry/activePaths.ts's `coeffA`/
  `coeffB`). Each configuration is one `IndirectPathCandidate` with its own
  two half-leg booleans -- this is the literal "two independent boolean
  variables" per indirect path from the spec; the actual A<->B length
  relationship is gated (via big-M, in path_network_vars.py) by *both* of
  that configuration's booleans together, so a half-leg shared with some
  other candidate doesn't spuriously force this pair's distance match unless
  both of THIS pair's own legs are the ones actually selected.
- An intermediate point is only structurally meaningful as a genuine 3-way
  (or more) crease junction -- a 2-leg "point" is just a kink in what's
  really a single bent line, no more useful than the two legs it's made of.
  So a point group's leg count is either 0 or >= MIN_VERTEX_DEGREE, never in
  between (enforced in path_network_vars.py's dangling-prevention
  constraint). Any point group that structurally *can't* reach
  MIN_VERTEX_DEGREE (fewer than that many legs ever share it) is useless as
  an indirect bend, so it's removed here entirely -- its underlying pair
  gets a replacement `DirectPathCandidate` instead, using the snapped angle
  that was originally rejected for exceeding the angle tolerance (with a
  correspondingly low starting confidence, since it isn't actually satisfied
  yet). This turns a doomed bend into something the solver can still choose
  to satisfy by moving positions, rather than two half-legs that could never
  legally be selected together.
- "A flap cannot have two paths in the same direction" is enforced by NAND
  pairs between *every* pair of candidates (direct or half-leg) sharing a
  (flap, direction-bin) slot -- computed in a single final pass over the
  fully-resolved direct-path and half-leg sets (after doomed-group removal
  and replacement), so the newly-added replacement candidates are covered by
  exactly the same mechanism as everything else, not a special case.
- Leaf pairs that are already far apart get a cheap raw-distance constraint
  (`far_pairs`) rather than being dropped entirely: skipping the constraint
  outright left any length whose every pair got pruned with *no* upper bound
  at all, which (combined with the length-change objective term) let it grow
  without limit. `overlap_pairs` keeps the exact separating-axis check for
  pairs close enough that it actually matters.
- Each candidate gets a `confidence` in [0, 1] from how close it already is
  to satisfying its own tangency test in the *current* layout -- 1.0 if
  already touching/overlapping, decaying to 0 at the tolerance boundary.
  This seeds the solve's initial boolean guess (see path_network_vars.py's
  `build_initial_guess`) closer to "already selected" for pairs that are
  obviously meant to be active, instead of a neutral 0.5 for everything.
"""

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

import networkx as nx

from app.core.shapes import get_bases
from app.core.tree import find_distance

# An intermediate point is only useful as a genuine multi-way junction --
# see the module docstring.
MIN_VERTEX_DEGREE = 3


@dataclass
class DirectPathCandidate:
    id: str
    a: str
    b: str
    angle: float  # snapped direction from a to b
    confidence: float = 1.0


@dataclass
class HalfLeg:
    """A deduplicated, shared half-leg variable: one physical crease
    direction from one flap, ending at `point_group_id`."""

    id: str
    flap: str
    angle: float
    point_group_id: str
    confidence: float = 1.0


@dataclass
class PointGroup:
    id: str
    natural_point: Tuple[float, float]
    half_leg_ids: List[str] = field(default_factory=list)


@dataclass
class IndirectPathCandidate:
    """One of the (up to two) bend configurations for an ambiguous semi-
    active pair whose point group actually reached MIN_VERTEX_DEGREE.
    `leg_a_id`/`leg_b_id` index into the preprocessing result's `half_legs`
    -- possibly shared with other candidates."""

    a: str
    b: str
    leg_a_id: str
    leg_b_id: str
    target_distance: float  # tree distance between a and b (unscaled)


@dataclass
class PathNetworkPreprocessing:
    direct_paths: List[DirectPathCandidate]
    indirect_paths: List[IndirectPathCandidate]
    half_legs: Dict[str, HalfLeg]
    point_groups: Dict[str, PointGroup]
    # Pairs of boolean-variable ids (a DirectPathCandidate.id or a HalfLeg.id)
    # that may not both be active -- same physical direction slot.
    nand_pairs: List[Tuple[str, str]]
    # Leaf pairs close enough (relative to their tree distance) that the
    # exact separating-axis non-overlap constraint is worth its cost.
    overlap_pairs: List[Tuple[str, str]]
    # Every other pair -- still gets a cheap raw-distance floor (see the
    # module docstring) instead of no constraint at all.
    far_pairs: List[Tuple[str, str]]


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


def _confidence(ratio: float, length_tolerance: float, angle_ratio: Optional[float] = None) -> float:
    """1.0 when the candidate is already exactly tangent or actively
    overlapping (ratio = actual/required <= 1), decaying linearly to 0 at
    the tolerance boundary otherwise. `angle_ratio` (deviation / tolerance)
    is combined via the minimum -- a candidate is only as confident as its
    worst-satisfied criterion. Also used (with a deliberately out-of-range
    angle_ratio) to seed a low confidence for replacement direct-path
    candidates, which are NOT yet angle-satisfied at all."""
    if ratio <= 1.0:
        dist_score = 1.0
    elif length_tolerance > 0:
        dist_score = max(0.0, 1.0 - (ratio - 1.0) / length_tolerance)
    else:
        dist_score = 0.0
    if angle_ratio is None:
        return dist_score
    angle_score = max(0.0, 1.0 - angle_ratio)
    return min(dist_score, angle_score)


def compute_path_network(
    tree: nx.DiGraph,
    leaf_ids: List[str],
    positions: Dict[str, Tuple[float, float]],
    scale: float,
    shape: str,
    symmetry_mode: str,
    extra_rotation: bool,
    length_tolerance: float,
    angle_tolerance_degrees: float,
) -> Optional[PathNetworkPreprocessing]:
    bases = get_bases(shape, symmetry_mode, extra_rotation)
    if bases is None:
        return None

    n = len(bases)
    period = 2 * math.pi / n
    offset_angle = math.atan2(bases[0][1], bases[0][0])
    angle_tolerance = math.radians(angle_tolerance_degrees)

    ids = [leaf_id for leaf_id in leaf_ids if leaf_id in positions]

    direct_paths: List[DirectPathCandidate] = []
    # Each entry: (flap, angle, candidate_index, "a" or "b", natural_point, confidence)
    raw_refs: List[Tuple[str, float, int, str, Tuple[float, float], float]] = []
    # Each entry mirrors an IndirectPathCandidate before leg ids are resolved:
    # (a, b, target_distance, rejected snapped angle, replacement confidence).
    pending_indirect: List[Tuple[str, str, float, float, float]] = []

    def add_direct(a: str, b: str, angle: float, confidence: float) -> None:
        direct_paths.append(DirectPathCandidate(id=f"direct::{a}::{b}", a=a, b=b, angle=angle, confidence=confidence))

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
                angle_ratio = abs(rel) / angle_tolerance if angle_tolerance > 0 else 0.0
                add_direct(a, b, nearest, _confidence(ratio, length_tolerance, angle_ratio))
                continue

            theta_lo = nearest
            theta_hi = nearest + math.copysign(period, rel)
            u1 = (math.cos(theta_lo), math.sin(theta_lo))
            u2 = (math.cos(theta_hi), math.sin(theta_hi))
            det = u1[0] * u2[1] - u1[1] * u2[0]
            if abs(det) < 1e-9:
                add_direct(a, b, nearest, _confidence(ratio, length_tolerance))
                continue
            coeff_a = (dx * u2[1] - dy * u2[0]) / det
            coeff_b = (dy * u1[0] - dx * u1[1]) / det

            confidence = _confidence(ratio, length_tolerance)
            angle_ratio = abs(rel) / angle_tolerance if angle_tolerance > 0 else float("inf")
            replacement_confidence = _confidence(ratio, length_tolerance, angle_ratio)
            candidate_idx = len(pending_indirect)
            pending_indirect.append((a, b, find_distance(tree, a, b), nearest, replacement_confidence))

            p1 = (pa[0] + coeff_a * u1[0], pa[1] + coeff_a * u1[1])
            p2 = (pa[0] + coeff_b * u2[0], pa[1] + coeff_b * u2[1])

            leg_a1_angle = theta_lo if coeff_a >= 0 else theta_lo + math.pi
            leg_b1_angle = (theta_hi + math.pi) if coeff_b >= 0 else theta_hi
            leg_a2_angle = theta_hi if coeff_b >= 0 else theta_hi + math.pi
            leg_b2_angle = (theta_lo + math.pi) if coeff_a >= 0 else theta_lo

            raw_refs.append((a, leg_a1_angle, candidate_idx, "a1", p1, confidence))
            raw_refs.append((b, leg_b1_angle, candidate_idx, "b1", p1, confidence))
            raw_refs.append((a, leg_a2_angle, candidate_idx, "a2", p2, confidence))
            raw_refs.append((b, leg_b2_angle, candidate_idx, "b2", p2, confidence))

    # --- Leg identity: every raw ref at the same (flap, direction-bin) is
    # the same physical leg, full stop -- no proximity check, since a ray is
    # already fully determined by its flap and its committed direction.
    slot_to_leg_id: Dict[Tuple[str, int], str] = {}
    ref_to_leg_id: Dict[int, str] = {}
    half_legs: Dict[str, HalfLeg] = {}
    leg_natural_point: Dict[str, Tuple[float, float]] = {}
    leg_counter = 0
    for idx, (flap, angle, _cand, _role, point, conf) in enumerate(raw_refs):
        key = (flap, _bin_index(angle, offset_angle, period, n))
        leg_id = slot_to_leg_id.get(key)
        if leg_id is None:
            leg_id = f"leg::{flap}::{leg_counter}"
            leg_counter += 1
            slot_to_leg_id[key] = leg_id
            half_legs[leg_id] = HalfLeg(id=leg_id, flap=flap, angle=angle, point_group_id="", confidence=conf)
            leg_natural_point[leg_id] = point
        else:
            half_legs[leg_id].confidence = max(half_legs[leg_id].confidence, conf)
        ref_to_leg_id[idx] = leg_id

    # --- Point-group clustering: a union-find over LEG IDS (not positions)
    # -- each indirect candidate unions its own two legs, so any leg shared
    # (via the identical slot) between two different candidates
    # transitively merges their points into one, exactly the "shared
    # direction forms a triplet" mechanism from the module docstring. Purely
    # combinatorial: never looks at where any leg's naive endpoint guess
    # actually landed.
    leg_ids_ordered = list(half_legs.keys())
    leg_index = {leg_id: i for i, leg_id in enumerate(leg_ids_ordered)}
    uf_points = _UnionFind(len(leg_ids_ordered))
    for candidate_idx in range(len(pending_indirect)):
        refs_for_candidate = {
            role: ref_to_leg_id[global_idx]
            for global_idx, (flap, angle, cand, role, point, conf) in enumerate(raw_refs)
            if cand == candidate_idx
        }
        uf_points.union(leg_index[refs_for_candidate["a1"]], leg_index[refs_for_candidate["b1"]])
        uf_points.union(leg_index[refs_for_candidate["a2"]], leg_index[refs_for_candidate["b2"]])

    point_groups: Dict[str, PointGroup] = {}
    point_cluster_id: Dict[int, str] = {}
    group_counter = 0
    for local_i, leg_id in enumerate(leg_ids_ordered):
        root = uf_points.find(local_i)
        if root not in point_cluster_id:
            point_cluster_id[root] = f"point::{group_counter}"
            group_counter += 1
        group_id = point_cluster_id[root]
        if group_id not in point_groups:
            point_groups[group_id] = PointGroup(id=group_id, natural_point=(0.0, 0.0), half_leg_ids=[])
        point_groups[group_id].half_leg_ids.append(leg_id)
        half_legs[leg_id].point_group_id = group_id

    # natural_point is purely an initial-guess seed for the solver (see
    # path_network_vars.py's build_initial_guess) -- never used for the
    # clustering decision itself, which is entirely structural above.
    for group in point_groups.values():
        xs = [leg_natural_point[leg_id][0] for leg_id in group.half_leg_ids]
        ys = [leg_natural_point[leg_id][1] for leg_id in group.half_leg_ids]
        group.natural_point = (sum(xs) / len(xs), sum(ys) / len(ys))

    # --- Remove point groups that can never reach MIN_VERTEX_DEGREE, and
    # replace the underlying pair's bend attempt with a direct-path
    # candidate instead (see the module docstring).
    doomed_group_ids = {gid for gid, g in point_groups.items() if len(g.half_leg_ids) < MIN_VERTEX_DEGREE}

    indirect_paths: List[IndirectPathCandidate] = []
    replacements: Set[Tuple[str, str, float, float]] = set()
    for candidate_idx, (a, b, target_distance, nearest_angle, replacement_confidence) in enumerate(pending_indirect):
        refs_for_candidate = [
            (role, global_idx)
            for global_idx, (flap, angle, cand, role, point, _conf) in enumerate(raw_refs)
            if cand == candidate_idx
        ]
        by_role = {role: ref_to_leg_id[global_idx] for role, global_idx in refs_for_candidate}
        for leg_a_key, leg_b_key in (("a1", "b1"), ("a2", "b2")):
            leg_a_id = by_role[leg_a_key]
            leg_b_id = by_role[leg_b_key]
            # leg_a and leg_b of one config always share the identical
            # natural point (by construction), so they're always in the
            # same group -- checking either is equivalent to checking both.
            group_id = half_legs[leg_a_id].point_group_id
            if group_id in doomed_group_ids:
                replacements.add((a, b, nearest_angle, replacement_confidence))
                continue
            indirect_paths.append(
                IndirectPathCandidate(a=a, b=b, leg_a_id=leg_a_id, leg_b_id=leg_b_id, target_distance=target_distance)
            )

    for gid in doomed_group_ids:
        for leg_id in point_groups[gid].half_leg_ids:
            del half_legs[leg_id]
        del point_groups[gid]

    added_pairs: Set[Tuple[str, str]] = set()
    for a, b, nearest_angle, replacement_confidence in replacements:
        if (a, b) in added_pairs:
            continue
        added_pairs.add((a, b))
        add_direct(a, b, nearest_angle, replacement_confidence)

    # --- Final NAND pass: every pair of candidates (direct or half-leg)
    # sharing a (flap, direction-bin) slot, computed once over the fully
    # resolved sets -- covers the replacement direct paths added above by
    # the exact same mechanism as everything else.
    final_slots: Dict[Tuple[str, int], List[str]] = {}
    for direct in direct_paths:
        final_slots.setdefault((direct.a, _bin_index(direct.angle, offset_angle, period, n)), []).append(direct.id)
        final_slots.setdefault((direct.b, _bin_index(direct.angle + math.pi, offset_angle, period, n)), []).append(direct.id)
    for leg in half_legs.values():
        final_slots.setdefault((leg.flap, _bin_index(leg.angle, offset_angle, period, n)), []).append(leg.id)

    nand_pairs: List[Tuple[str, str]] = []
    for members in final_slots.values():
        for x in range(len(members)):
            for y in range(x + 1, len(members)):
                if members[x] != members[y]:
                    nand_pairs.append((members[x], members[y]))

    overlap_pairs: List[Tuple[str, str]] = []
    far_pairs: List[Tuple[str, str]] = []
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = ids[i], ids[j]
            pa, pb = positions[a], positions[b]
            actual = math.hypot(pb[0] - pa[0], pb[1] - pa[1])
            tree_dist = find_distance(tree, a, b)
            if actual < 2 * scale * tree_dist:
                overlap_pairs.append((a, b))
            else:
                far_pairs.append((a, b))

    return PathNetworkPreprocessing(
        direct_paths=direct_paths,
        indirect_paths=indirect_paths,
        half_legs=half_legs,
        point_groups=point_groups,
        nand_pairs=nand_pairs,
        overlap_pairs=overlap_pairs,
        far_pairs=far_pairs,
    )
