import math

from app.core.active_paths import compute_active_paths, path_edge_ids
from app.core.tree import build_tree
from app.schemas.tree import NodeIn, TreeIn


def _two_leaf_tree(len_a: float = 1.0, len_b: float = 1.0):
    return build_tree(
        TreeIn(
            root_id="root",
            nodes=[
                NodeIn(id="root", parent_id=None, length=None),
                NodeIn(id="leaf_a", parent_id="root", length=len_a),
                NodeIn(id="leaf_b", parent_id="root", length=len_b),
            ],
        )
    )


def _positions_at_angle(scale: float, required: float, angle_rad: float):
    return {
        "leaf_a": (0.0, 0.0),
        "leaf_b": (required * math.cos(angle_rad), required * math.sin(angle_rad)),
    }


def test_compute_active_paths_detects_aligned_pair():
    tree = _two_leaf_tree()
    scale = 0.4
    required = scale * 2.0
    positions = _positions_at_angle(scale, required, 0.0)
    paths = compute_active_paths(tree, ["leaf_a", "leaf_b"], positions, scale, "octagon", "none", False, 0.1, 10.0)
    assert len(paths) == 1
    assert math.isclose(paths[0].angle, 0.0, abs_tol=1e-9)


def test_compute_active_paths_ignores_angle_out_of_tolerance():
    tree = _two_leaf_tree()
    scale = 0.4
    required = scale * 2.0
    # Octagon's period is 45 degrees -- 20 degrees is roughly equidistant
    # from the 0 and 45 multiples, well outside the default 10-degree
    # tolerance of either.
    positions = _positions_at_angle(scale, required, math.radians(20))
    paths = compute_active_paths(tree, ["leaf_a", "leaf_b"], positions, scale, "octagon", "none", False, 0.1, 10.0)
    assert paths == []


def test_compute_active_paths_ignores_length_out_of_tolerance():
    tree = _two_leaf_tree()
    scale = 0.4
    required = scale * 2.0
    # Half the required tangency distance -- nowhere near the default
    # 0.1 relative length tolerance.
    positions = _positions_at_angle(scale, required / 2, 0.0)
    paths = compute_active_paths(tree, ["leaf_a", "leaf_b"], positions, scale, "octagon", "none", False, 0.1, 10.0)
    assert paths == []


def test_compute_active_paths_snaps_to_nearest_nonzero_multiple():
    tree = _two_leaf_tree()
    scale = 0.4
    required = scale * 2.0
    # 50 degrees is within 10 degrees of octagon's 45-degree basis.
    positions = _positions_at_angle(scale, required, math.radians(50))
    paths = compute_active_paths(tree, ["leaf_a", "leaf_b"], positions, scale, "octagon", "none", False, 0.1, 10.0)
    assert len(paths) == 1
    assert math.isclose(paths[0].angle, math.pi / 4, abs_tol=1e-9)


def test_compute_active_paths_respects_rotation_offset():
    tree = _two_leaf_tree()
    scale = 0.4
    required = scale * 2.0
    # 20 degrees is out of tolerance of octagon's unrotated multiples of 45
    # (test above), but dodecagon rotated 15 degrees has a basis at exactly
    # 15 degrees, well within 10 degrees of 20.
    positions = _positions_at_angle(scale, required, math.radians(20))
    paths = compute_active_paths(tree, ["leaf_a", "leaf_b"], positions, scale, "dodecagon", "none", True, 0.1, 10.0)
    assert len(paths) == 1
    assert math.isclose(paths[0].angle, math.pi / 12, abs_tol=1e-9)


def test_compute_active_paths_circle_has_no_angle_to_snap():
    tree = _two_leaf_tree()
    scale = 0.4
    required = scale * 2.0
    positions = _positions_at_angle(scale, required, math.radians(20))
    paths = compute_active_paths(tree, ["leaf_a", "leaf_b"], positions, scale, "circle", "none", False, 0.1, 10.0)
    assert paths == []


def test_path_edge_ids_direct_siblings():
    tree = _two_leaf_tree()
    assert set(path_edge_ids(tree, "leaf_a", "leaf_b")) == {"leaf_a", "leaf_b"}


def test_path_edge_ids_through_internal_node():
    tree = build_tree(
        TreeIn(
            root_id="root",
            nodes=[
                NodeIn(id="root", parent_id=None, length=None),
                NodeIn(id="branch", parent_id="root", length=2.0),
                NodeIn(id="leaf_a", parent_id="branch", length=1.0),
                NodeIn(id="leaf_b", parent_id="root", length=1.0),
            ],
        )
    )
    assert path_edge_ids(tree, "leaf_a", "leaf_b") == ["leaf_a", "branch", "leaf_b"]
