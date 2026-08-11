import math

import pytest

from app.core.tiling_candidates import HalfLeg, PointGroup, _point_group_heuristic, enumerate_tiling_candidates
from app.core.tree import build_tree
from app.schemas.tree import NodeIn, TreeIn


def _octagon_tree_direct_pair():
    tree = build_tree(
        TreeIn(
            root_id="root",
            nodes=[
                NodeIn(id="root", parent_id=None, length=None),
                NodeIn(id="a", parent_id="root", length=1.0),
                NodeIn(id="b", parent_id="root", length=1.0),
            ],
        )
    )
    positions = {"a": (0.1, 0.5), "b": (0.1 + 2.0, 0.5)}
    return tree, ["a", "b"], positions


def test_direct_pair_produces_no_indirect_candidates():
    tree, leaf_ids, positions = _octagon_tree_direct_pair()
    result = enumerate_tiling_candidates(
        tree, leaf_ids, positions, scale=1.0, shape="octagon", symmetry_mode="none",
        extra_rotation=False, length_tolerance=0.05, angle_tolerance_degrees=10.0,
    )
    assert result is not None
    assert len(result.direct_paths) == 1
    assert result.direct_paths[0].a == "a"
    assert result.direct_paths[0].b == "b"
    assert result.point_groups == {}
    assert result.half_legs == {}
    assert result.two_leg_bends == []
    assert result.n_bins == 8
    assert result.period == pytest.approx(math.pi / 4)
    # Direct path a->b snapped to angle 0 -- occupies bin 0 at "a" and the
    # opposite bin (4) at "b" (angle + pi).
    assert result.flap_bins[("a", 0)] == [result.direct_paths[0].id]
    assert result.flap_bins[("b", 4)] == [result.direct_paths[0].id]


def test_circle_shape_returns_none():
    tree, leaf_ids, positions = _octagon_tree_direct_pair()
    result = enumerate_tiling_candidates(
        tree, leaf_ids, positions, 1.0, "circle", "none", False, 0.05, 10.0
    )
    assert result is None


def test_semi_active_pair_becomes_two_leg_bend_not_a_direct_path():
    # Same tangency distance as the direct case, but rotated off-axis so the
    # connecting angle isn't a valid octagon direction. With only two leaves,
    # neither of the two bend configurations can ever gather a third leg, so
    # both stay as free TwoLegBend fallbacks -- NOT replaced with a
    # low-confidence direct path (that was the old path_network.py behavior;
    # this redesign keeps them as free/fallback instead).
    tree = build_tree(
        TreeIn(
            root_id="root",
            nodes=[
                NodeIn(id="root", parent_id=None, length=None),
                NodeIn(id="a", parent_id="root", length=1.0),
                NodeIn(id="b", parent_id="root", length=1.0),
            ],
        )
    )
    angle = math.radians(20.0)
    dist = 2.0
    pa = (0.3, 0.3)
    pb = (pa[0] + dist * math.cos(angle), pa[1] + dist * math.sin(angle))
    positions = {"a": pa, "b": pb}

    result = enumerate_tiling_candidates(
        tree, ["a", "b"], positions, scale=1.0, shape="octagon", symmetry_mode="none",
        extra_rotation=False, length_tolerance=0.05, angle_tolerance_degrees=10.0,
    )
    assert result is not None
    assert result.direct_paths == []
    assert result.point_groups == {}
    assert result.half_legs == {}
    assert len(result.two_leg_bends) == 2
    for bend in result.two_leg_bends:
        assert {bend.a, bend.b} == {"a", "b"}


def _triplet_tree_and_positions():
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


def test_shared_direction_at_one_flap_forms_two_point_groups_of_three():
    # Flap A has two indirect candidates (to B and to C) that both commit to
    # the same octagon direction at A -- the shared leg transitively merges
    # both candidates' points into one triplet each (one per bend
    # configuration), matching path_network.py's original "shared direction
    # forms a triplet" mechanism, reused here unchanged.
    tree, positions, scale = _triplet_tree_and_positions()
    result = enumerate_tiling_candidates(
        tree, ["a", "b", "c"], positions, scale=scale, shape="octagon", symmetry_mode="none",
        extra_rotation=False, length_tolerance=0.05, angle_tolerance_degrees=10.0,
    )
    assert result is not None
    assert result.direct_paths == []
    assert result.two_leg_bends == []
    assert len(result.point_groups) == 2
    for group in result.point_groups.values():
        assert len(group.half_leg_ids) == 3
        flaps = {result.half_legs[leg_id].flap for leg_id in group.half_leg_ids}
        assert flaps == {"a", "b", "c"}
    for group_id, group in result.point_groups.items():
        for leg_id in group.half_leg_ids:
            assert result.half_legs[leg_id].point_group_id == group_id


def test_point_group_heuristic_is_near_zero_for_already_concurrent_legs():
    # Hand-built, not derived from the ambiguous-pair pipeline: three flaps
    # placed so their committed leg directions genuinely meet at one point --
    # the fixture used to exercise "already satisfies its own constraint" is
    # a different, stronger claim than "was returned by enumeration," so it's
    # constructed directly here rather than assumed of a geometry fixture
    # that was never guaranteed to already be exactly concurrent.
    point = (0.5, 0.4)
    angles = [math.radians(0.0), math.radians(120.0), math.radians(250.0)]
    distances = [0.3, 0.25, 0.35]
    flaps = ["f0", "f1", "f2"]
    positions = {
        flap: (point[0] - dist * math.cos(angle), point[1] - dist * math.sin(angle))
        for flap, angle, dist in zip(flaps, angles, distances)
    }
    legs = {f"leg{i}": HalfLeg(id=f"leg{i}", flap=flap, angle=angle, point_group_id="g") for i, (flap, angle) in enumerate(zip(flaps, angles))}
    group = PointGroup(id="g", half_leg_ids=list(legs.keys()))
    assert _point_group_heuristic(group, legs, positions) == pytest.approx(0.0, abs=1e-9)


def test_point_group_heuristic_is_larger_for_a_non_concurrent_layout():
    point = (0.5, 0.4)
    angles = [math.radians(0.0), math.radians(120.0), math.radians(250.0)]
    distances = [0.3, 0.25, 0.35]
    flaps = ["f0", "f1", "f2"]
    positions = {
        flap: (point[0] - dist * math.cos(angle), point[1] - dist * math.sin(angle))
        for flap, angle, dist in zip(flaps, angles, distances)
    }
    positions["f0"] = (positions["f0"][0], positions["f0"][1] + 0.05)
    legs = {f"leg{i}": HalfLeg(id=f"leg{i}", flap=flap, angle=angle, point_group_id="g") for i, (flap, angle) in enumerate(zip(flaps, angles))}
    group = PointGroup(id="g", half_leg_ids=list(legs.keys()))
    assert _point_group_heuristic(group, legs, positions) > 1e-3


def test_point_group_heuristic_handles_two_parallel_legs_without_crashing():
    # Two of the three legs share a direction (a real, common case -- see
    # the triplet fixture below, where this actually happens) -- pairwise
    # line intersection would be undefined for that pair; the least-squares
    # formulation handles it gracefully instead of returning infinity.
    tree, positions, scale = _triplet_tree_and_positions()
    result = enumerate_tiling_candidates(
        tree, ["a", "b", "c"], positions, scale=scale, shape="octagon", symmetry_mode="none",
        extra_rotation=False, length_tolerance=0.05, angle_tolerance_degrees=10.0,
    )
    assert result is not None
    assert len(result.point_groups) == 2
    for group_id in result.point_groups:
        assert math.isfinite(result.heuristics[group_id])


def test_convex_hull_separates_interior_from_boundary_flaps():
    # A center flap surrounded by 4 cardinal flaps -- the center is strictly
    # inside the convex hull of the outer 4, which are themselves all on it.
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
    result = enumerate_tiling_candidates(
        tree, ["center", "n", "s", "e", "w"], positions, scale=0.1, shape="octagon", symmetry_mode="none",
        extra_rotation=False, length_tolerance=0.05, angle_tolerance_degrees=10.0,
    )
    assert result is not None
    assert result.hull_flap_ids == {"n", "s", "e", "w"}


def test_degenerate_collinear_input_does_not_crash_hull_computation():
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
    positions = {"a": (0.1, 0.5), "b": (0.4, 0.5), "c": (0.7, 0.5)}
    result = enumerate_tiling_candidates(
        tree, ["a", "b", "c"], positions, scale=1.0, shape="octagon", symmetry_mode="none",
        extra_rotation=False, length_tolerance=0.05, angle_tolerance_degrees=10.0,
    )
    assert result is not None
    assert result.hull_flap_ids == {"a", "b", "c"}
