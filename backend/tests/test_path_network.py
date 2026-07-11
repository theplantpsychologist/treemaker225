import math

import pytest

from app.core.path_network import compute_path_network
from app.core.tree import build_tree
from app.schemas.tree import NodeIn, TreeIn


def _octagon_tree_direct_pair():
    # Two leaves whose tree distance is 2.0; placed exactly tangent along a
    # horizontal (0-degree) octagon face-normal direction -- a clean direct
    # path with no ambiguity at all.
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
    result = compute_path_network(
        tree,
        leaf_ids,
        positions,
        scale=1.0,
        shape="octagon",
        symmetry_mode="none",
        extra_rotation=False,
        length_tolerance=0.05,
        angle_tolerance_degrees=10.0,
    )
    assert result is not None
    assert len(result.direct_paths) == 1
    assert result.direct_paths[0].a == "a"
    assert result.direct_paths[0].b == "b"
    # Exactly tangent and exactly aligned -- maximal initial confidence.
    assert result.direct_paths[0].confidence == 1.0
    assert result.indirect_paths == []
    assert result.half_legs == {}
    assert result.point_groups == {}


def test_circle_shape_returns_none():
    tree, leaf_ids, positions = _octagon_tree_direct_pair()
    result = compute_path_network(
        tree, leaf_ids, positions, 1.0, "circle", "none", False, 0.05, 10.0
    )
    assert result is None


def test_semi_active_pair_with_no_third_leg_gets_replaced_by_direct_path():
    # Same tangency distance as the direct case, but rotated off-axis so the
    # connecting angle isn't a valid octagon direction -- this is exactly
    # today's "semi-active" case in activePaths.ts. With only two leaves,
    # neither of the two candidate bend configurations can ever gather a
    # third leg to reach MIN_VERTEX_DEGREE, so both point groups are doomed
    # and the pair gets replaced by a single direct-path candidate instead
    # (with low confidence, since the angle genuinely isn't satisfied yet).
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
    angle = math.radians(20.0)  # well inside one 45-degree octagon sector
    dist = 2.0
    pa = (0.3, 0.3)
    pb = (pa[0] + dist * math.cos(angle), pa[1] + dist * math.sin(angle))
    positions = {"a": pa, "b": pb}

    result = compute_path_network(
        tree,
        ["a", "b"],
        positions,
        scale=1.0,
        shape="octagon",
        symmetry_mode="none",
        extra_rotation=False,
        length_tolerance=0.05,
        angle_tolerance_degrees=10.0,
    )
    assert result is not None
    assert result.indirect_paths == []
    assert result.half_legs == {}
    assert result.point_groups == {}
    assert len(result.direct_paths) == 1
    assert result.direct_paths[0].a == "a"
    assert result.direct_paths[0].b == "b"
    assert result.direct_paths[0].confidence < 1.0


def test_shared_direction_at_one_flap_forms_degree_three_point_group():
    # Flap A has two indirect candidates (to B and to C) that both commit to
    # the same octagon direction at A -- the shared leg transitively merges
    # both candidates' points into one triplet (A's shared leg + B's own far
    # leg + C's own far leg), per the module docstring. All three tree
    # distances are equal (star tree through root), so B and C are placed at
    # two different angles within the SAME 45-degree sector from A.
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
    positions = {"a": a, "b": b, "c": c}

    result = compute_path_network(
        tree, ["a", "b", "c"], positions, scale=scale, shape="octagon", symmetry_mode="none",
        extra_rotation=False, length_tolerance=0.05, angle_tolerance_degrees=10.0,
    )
    assert result is not None
    assert result.direct_paths == []
    assert len(result.point_groups) == 2
    for group in result.point_groups.values():
        assert len(group.half_leg_ids) == 3
        flaps = {result.half_legs[leg_id].flap for leg_id in group.half_leg_ids}
        assert flaps == {"a", "b", "c"}

    # Every half-leg belongs to some point group, and every point group's
    # members are exactly the half-legs that point to it.
    for group_id, group in result.point_groups.items():
        for leg_id in group.half_leg_ids:
            assert result.half_legs[leg_id].point_group_id == group_id


def test_overlap_pairs_prunes_far_apart_leaves():
    tree = build_tree(
        TreeIn(
            root_id="root",
            nodes=[
                NodeIn(id="root", parent_id=None, length=None),
                NodeIn(id="near", parent_id="root", length=1.0),
                NodeIn(id="far", parent_id="root", length=1.0),
            ],
        )
    )
    # tree distance near<->far is 2.0; placing them 10 units apart is far
    # beyond the 2*scale*treeDist pruning threshold (4.0).
    positions = {"near": (0.0, 0.0), "far": (10.0, 0.0)}
    result = compute_path_network(
        tree, ["near", "far"], positions, 1.0, "octagon", "none", False, 0.05, 10.0
    )
    assert result is not None
    assert result.overlap_pairs == []
    # Pruned from the expensive check, but not dropped outright -- still
    # gets the cheap raw-distance floor (see the module docstring).
    assert ("near", "far") in result.far_pairs


def test_direct_confidence_decays_with_distance_from_exact_tangency():
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
    length_tolerance = 0.1
    # required (tree-implied tangency) distance is 2.0 at scale=1.
    def confidence_for(actual_dist):
        positions = {"a": (0.1, 0.5), "b": (0.1 + actual_dist, 0.5)}
        result = compute_path_network(
            tree, ["a", "b"], positions, 1.0, "octagon", "none", False, length_tolerance, 10.0
        )
        assert result is not None and len(result.direct_paths) == 1
        return result.direct_paths[0].confidence

    # Overlapping (actual < required) or exactly tangent -- max confidence.
    assert confidence_for(1.8) == 1.0
    assert confidence_for(2.0) == 1.0
    # Halfway to the tolerance boundary (required*(1+tolerance/2)) -- partial.
    halfway = confidence_for(2.0 * (1 + length_tolerance / 2))
    assert 0.0 < halfway < 1.0
    # Right at the tolerance boundary -- confidence bottoms out at 0.
    boundary = confidence_for(2.0 * (1 + length_tolerance) - 1e-6)
    assert boundary == pytest.approx(0.0, abs=1e-3)


def test_overlap_pairs_keeps_close_leaves():
    tree = build_tree(
        TreeIn(
            root_id="root",
            nodes=[
                NodeIn(id="root", parent_id=None, length=None),
                NodeIn(id="near", parent_id="root", length=1.0),
                NodeIn(id="other", parent_id="root", length=1.0),
            ],
        )
    )
    positions = {"near": (0.0, 0.0), "other": (1.5, 0.0)}
    result = compute_path_network(
        tree, ["near", "other"], positions, 1.0, "octagon", "none", False, 0.05, 10.0
    )
    assert result is not None
    assert ("near", "other") in result.overlap_pairs
