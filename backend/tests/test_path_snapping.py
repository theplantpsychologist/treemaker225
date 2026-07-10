import math

import numpy as np

from app.core.active_paths import ActivePathEdge
from app.core.path_snapping import (
    VariableIndex,
    build_anchor_constraints,
    build_angle_constraints,
    build_length_constraints,
    solve_snap,
)
from app.core.tree import build_tree
from app.schemas.tree import NodeIn, TreeIn


def test_variable_index_layout():
    index = VariableIndex.build(["leaf_a", "leaf_b"], ["leaf_a", "leaf_b", "branch"])
    assert index.pos_col == {"leaf_a": 0, "leaf_b": 2}
    assert index.length_col == {"leaf_a": 4, "leaf_b": 5, "branch": 6}
    assert index.n_cols == 7


def test_build_angle_constraints_horizontal_target():
    index = VariableIndex.build(["leaf_a", "leaf_b"], [])
    paths = [ActivePathEdge(a="leaf_a", b="leaf_b", angle=0.0)]
    a, b = build_angle_constraints(paths, index)
    assert a.shape == (1, 4)
    # n = (-sin(0), cos(0)) = (0, 1) -- the row should be zero on every x
    # column and +-1 on the y columns only.
    expected = np.array([[0.0, -1.0, 0.0, 1.0]])
    assert np.allclose(a, expected)
    assert np.allclose(b, [0.0])


def test_build_angle_constraints_diagonal_target():
    index = VariableIndex.build(["leaf_a", "leaf_b"], [])
    paths = [ActivePathEdge(a="leaf_a", b="leaf_b", angle=math.pi / 4)]
    a, _ = build_angle_constraints(paths, index)
    n_x, n_y = -math.sin(math.pi / 4), math.cos(math.pi / 4)
    expected = np.array([[-n_x, -n_y, n_x, n_y]])
    assert np.allclose(a, expected)
    # A row built this way is satisfied by any point on the target diagonal.
    x_on_target = np.array([0.2, 0.2, 0.9, 0.9])
    assert np.allclose(a @ x_on_target, [0.0])
    x_off_target = np.array([0.2, 0.3, 0.9, 0.9])
    assert not np.allclose(a @ x_off_target, [0.0])


def test_build_length_constraints_direct_siblings():
    tree = build_tree(
        TreeIn(
            root_id="root",
            nodes=[
                NodeIn(id="root", parent_id=None, length=None),
                NodeIn(id="leaf_a", parent_id="root", length=1.0),
                NodeIn(id="leaf_b", parent_id="root", length=1.0),
            ],
        )
    )
    index = VariableIndex.build(["leaf_a", "leaf_b"], ["leaf_a", "leaf_b"])
    paths = [ActivePathEdge(a="leaf_a", b="leaf_b", angle=0.0)]
    a, b = build_length_constraints(paths, index, tree, scale=0.5)
    # angle=0 -> d=(1,0): +1 at leaf_b's x, -1 at leaf_a's x, -scale at both
    # length columns, nothing on either y column.
    expected = np.array([[-1.0, 0.0, 1.0, 0.0, -0.5, -0.5]])
    assert np.allclose(a, expected)
    assert np.allclose(b, [0.0])
    # A configuration that's exactly tangent along the target direction
    # should satisfy the row exactly.
    x = np.array([0.1, 0.5, 0.1 + 0.5 * (1.0 + 1.0), 0.5, 1.0, 1.0])
    assert np.allclose(a @ x, [0.0])


def test_build_anchor_constraints_picks_extremes():
    index = VariableIndex.build(["a", "b", "c"], [])
    positions = {"a": (0.1, 0.9), "b": (0.9, 0.1), "c": (0.5, 0.5)}
    a, b = build_anchor_constraints(["a", "b", "c"], positions, index)
    assert a.shape == (4, 6)
    x = np.array([0.1, 0.9, 0.9, 0.1, 0.5, 0.5])
    # max-x -> b pinned to x=1, min-x -> a pinned to x=0, max-y -> a pinned to
    # y=1, min-y -> b pinned to y=0.
    assert np.allclose(a @ x, [0.9, 0.1, 0.9, 0.1])
    assert np.allclose(b, [1.0, 0.0, 1.0, 0.0])


def test_solve_snap_no_op_when_already_consistent():
    x0 = np.array([0.5])
    a = np.array([[1.0]])
    b = np.array([0.0])
    result = solve_snap(x0, a, b, lower=np.array([-10.0]), upper=np.array([10.0]))
    assert math.isclose(result[0], 0.0, abs_tol=1e-6)


def test_solve_snap_bounds_win_over_equality():
    # x0 + x1 = -2 can only be satisfied with at least one negative value,
    # but both are bounded to [0, 10] -- bounds must win exactly (result
    # stays inside the box) even though the equality residual is nonzero.
    x0 = np.array([0.0, 1.0])
    a = np.array([[1.0, 1.0]])
    b = np.array([-2.0])
    result = solve_snap(x0, a, b, lower=np.array([0.0, 0.0]), upper=np.array([10.0, 10.0]))
    assert np.all(result >= -1e-9)
    assert np.all(result <= 10.0 + 1e-9)


def test_solve_snap_satisfies_consistent_equality_within_bounds():
    x0 = np.array([0.2, 0.9])
    a = np.array([[1.0, -1.0]])
    b = np.array([0.0])
    result = solve_snap(x0, a, b, lower=np.array([0.0, 0.0]), upper=np.array([1.0, 1.0]))
    assert math.isclose(result[0], result[1], abs_tol=1e-3)
    assert np.all(result >= -1e-9)
    assert np.all(result <= 1.0 + 1e-9)
