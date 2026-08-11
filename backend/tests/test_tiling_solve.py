import math

import pytest

from app.core.tiling_candidates import DirectPathCandidate, TilingCandidates, TwoLegBend
from app.core.tiling_solve import (
    _bin_is_exempt,
    _fill_remaining_gaps_with_bends,
    _flap_exempt_arc,
    _select_candidates_via_milp,
)
from app.core.tiling_solve import solve_tiling
from app.schemas.constraints import BoundaryConstraint, Constraints, LeafConstraint

N_BINS = 8
PERIOD = math.pi / 4  # octagon: 45 degrees per bin


def _octagon_candidates(direct_paths, heuristics, flap_bins, hull_flap_ids=frozenset()):
    return TilingCandidates(
        direct_paths=direct_paths,
        point_groups={},
        half_legs={},
        two_leg_bends=[],
        heuristics=heuristics,
        flap_bins=flap_bins,
        n_bins=N_BINS,
        offset_angle=0.0,
        period=PERIOD,
        hull_flap_ids=set(hull_flap_ids),
    )


def test_milp_forces_required_bins_and_picks_the_cheaper_of_two_alternatives():
    # Flap r only has real candidates at bins {0 (two rival options), 3, 6}.
    # Every window of 3 consecutive bins containing neither 0 nor 3 nor 6 is
    # structurally impossible (dropped) -- irrelevant here, every window DOES
    # contain one of these three bins (checked by hand). Bins 3 and 6 have
    # only one candidate each, so both are forced regardless of cost; bin 0
    # has two NAND-conflicting rivals of different cost, so the MILP must
    # pick exactly one (coverage needs >=1, NAND caps at <=1) -- the cheaper.
    d3 = DirectPathCandidate(id="d3", a="r", b="x3", angle=3 * PERIOD)
    d6 = DirectPathCandidate(id="d6", a="r", b="x6", angle=6 * PERIOD)
    d0_cheap = DirectPathCandidate(id="d0_cheap", a="r", b="x0a", angle=0.0)
    d0_exp = DirectPathCandidate(id="d0_exp", a="r", b="x0b", angle=0.0)
    candidates = _octagon_candidates(
        direct_paths=[d3, d6, d0_cheap, d0_exp],
        heuristics={"d3": 1.0, "d6": 1.0, "d0_cheap": 0.1, "d0_exp": 5.0},
        flap_bins={
            ("r", 3): ["d3"],
            ("r", 6): ["d6"],
            ("r", 0): ["d0_cheap", "d0_exp"],
        },
    )
    selected = _select_candidates_via_milp(["r"], {"r": (0.5, 0.5)}, Constraints(), candidates)
    assert "d3" in selected
    assert "d6" in selected
    assert "d0_cheap" in selected
    assert "d0_exp" not in selected


def test_milp_drops_structurally_impossible_windows_instead_of_failing():
    # Only bin 0 has any real candidate at all -- windows not touching bin 0
    # at all (e.g. [2,3,4]) are structurally impossible and must be dropped
    # rather than making the whole MILP infeasible.
    d0 = DirectPathCandidate(id="d0", a="r", b="x0", angle=0.0)
    candidates = _octagon_candidates(
        direct_paths=[d0], heuristics={"d0": 1.0}, flap_bins={("r", 0): ["d0"]}
    )
    selected = _select_candidates_via_milp(["r"], {"r": (0.5, 0.5)}, Constraints(), candidates)
    assert selected == {"d0"}


def test_milp_never_selects_a_candidate_that_touches_no_flap_at_all():
    # A candidate entirely between two flaps outside `leaf_ids` (e.g. a
    # different sub-solve's scope) shouldn't be forced in just because it
    # exists -- nothing here requires it, so minimizing cost leaves it out.
    d0 = DirectPathCandidate(id="d0", a="p", b="q", angle=0.0)
    candidates = _octagon_candidates(
        direct_paths=[d0], heuristics={"d0": 1.0}, flap_bins={("p", 0): ["d0"], ("q", 4): ["d0"]}
    )
    selected = _select_candidates_via_milp([], {}, Constraints(), candidates)
    assert selected == set()


def test_fallback_bend_patches_a_gap_the_milp_could_not_cover():
    # Only bins 0 and 4 (exactly opposite) have real candidates -- 2 points
    # can never give <180-degree coverage everywhere (see module docstring's
    # concurrency-heuristic reasoning applied to coverage instead), so windows
    # strictly between them (e.g. [1,2,3]) are dropped by the MILP as
    # structurally impossible. A two-leg bend touching bin 2 (inside that
    # gap) should get used by the fallback phase to patch it.
    d0 = DirectPathCandidate(id="d0", a="r", b="x0", angle=0.0)
    d4 = DirectPathCandidate(id="d4", a="r", b="x4", angle=4 * PERIOD)
    bend = TwoLegBend(id="bend_fix", a="r", b="y", angle_a=2 * PERIOD, angle_b=math.pi)
    candidates = _octagon_candidates(
        direct_paths=[d0, d4],
        heuristics={"d0": 1.0, "d4": 1.0},
        flap_bins={("r", 0): ["d0"], ("r", 4): ["d4"], ("r", 2): ["bend_fix"], ("y", 4): ["bend_fix"]},
    )
    candidates.two_leg_bends.append(bend)
    selected = _select_candidates_via_milp(["r"], {"r": (0.5, 0.5)}, Constraints(), candidates)
    assert selected == {"d0", "d4"}
    used = _fill_remaining_gaps_with_bends(["r"], {"r": (0.5, 0.5)}, Constraints(), candidates, selected)
    assert "bend_fix" in used


def test_flap_exempt_arc_is_none_for_a_plain_interior_flap():
    assert _flap_exempt_arc("r", (0.5, 0.5), Constraints(), hull_flap_ids=set()) is None


def test_flap_exempt_arc_for_hull_flap_faces_its_nearest_edge():
    # Very close to the left edge -- exempt arc should be centered on the
    # outward (-x, i.e. angle=pi) direction, so a bin pointing left (bin 4 at
    # angle=pi) is exempt but a bin pointing right (bin 0) is not.
    arc = _flap_exempt_arc("r", (0.02, 0.5), Constraints(), hull_flap_ids={"r"})
    assert arc is not None
    assert _bin_is_exempt(4 * PERIOD, arc)  # pi, pointing left/outward
    assert not _bin_is_exempt(0.0, arc)  # pointing right/inward


def test_flap_exempt_arc_for_explicit_corner_pin_is_wider_than_an_edge():
    # bottom_left (0,0): the quadrant pointing INTO the square is (0, 90)
    # degrees -- everything else (270 degrees) is exempt, per "greater than
    # 180 if it's a corner."
    constraints = Constraints(per_leaf={"r": LeafConstraint(boundary=BoundaryConstraint(kind="pin_corner", corner="bottom_left"))})
    arc = _flap_exempt_arc("r", (0.0, 0.0), constraints, hull_flap_ids=set())
    assert arc is not None
    assert not _bin_is_exempt(math.radians(45), arc)  # pointing straight into the square: required
    assert _bin_is_exempt(math.radians(180), arc)
    assert _bin_is_exempt(math.radians(315), arc)


def test_solve_tiling_end_to_end_with_octagon_star_produces_no_crash():
    # A center flap surrounded by 4 cardinal flaps (mirrors the API-level
    # fixture) run through the real enumerate_tiling_candidates pipeline and
    # the full solve_tiling -- sanity check the MILP + fallback + row-solve
    # pipeline composes without error on realistic data, and that every
    # selected direct path/vertex leg only ever references real flaps.
    from app.core.tiling_candidates import enumerate_tiling_candidates
    from app.core.tree import build_tree
    from app.schemas.tree import NodeIn, TreeIn

    tree = build_tree(
        TreeIn(
            root_id="root",
            nodes=[
                NodeIn(id="root", parent_id=None, length=None),
                NodeIn(id="center", parent_id="root", length=0.5),
                NodeIn(id="n", parent_id="root", length=0.5),
                NodeIn(id="s", parent_id="root", length=0.5),
                NodeIn(id="e", parent_id="root", length=0.5),
                NodeIn(id="w", parent_id="root", length=0.5),
            ],
        )
    )
    cx, cy = 0.5, 0.5
    positions = {
        "center": (cx, cy),
        "n": (cx, cy + 0.1),
        "s": (cx, cy - 0.1),
        "e": (cx + 0.1, cy),
        "w": (cx - 0.1, cy),
    }
    leaf_ids = ["center", "n", "s", "e", "w"]
    candidates = enumerate_tiling_candidates(
        tree, leaf_ids, positions, scale=0.1, shape="octagon", symmetry_mode="none",
        extra_rotation=False, length_tolerance=0.05, angle_tolerance_degrees=10.0,
    )
    assert candidates is not None
    result = solve_tiling(leaf_ids, positions, Constraints(), candidates)
    known_flaps = set(leaf_ids)
    for path in result.selected_direct_paths:
        assert path.a in known_flaps and path.b in known_flaps
    for vertex in result.vertices:
        for flap, _angle in vertex.legs:
            assert flap in known_flaps
    for flap in leaf_ids:
        assert flap in result.leaf_positions
