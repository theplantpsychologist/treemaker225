import math

import numpy as np
import pytest

from app.core.tiling_candidates import DirectPathCandidate, HalfLeg, line_intersection
from app.core.tiling_rows import Row, solve_min_perturbation, try_accept
from app.core.tiling_solve import _concurrency_row, _direct_row


def _row_value(row: Row, positions: dict) -> float:
    total = 0.0
    for (leaf_id, axis), coeff in row.coeffs.items():
        total += coeff * (positions[leaf_id][0] if axis == "x" else positions[leaf_id][1])
    return total - row.b


def test_try_accept_rejects_redundant_row():
    # Same coefficients, different constant -- can't tell "redundant and
    # consistent" from "redundant and conflicting" from rank alone, so the
    # safe default is to reject either way (see tiling_rows.py docstring).
    pos_col = {"a": 0, "b": 2}
    row1 = Row({("a", "x"): 1.0}, 0.5)
    row2 = Row({("a", "x"): 1.0}, 0.9)
    assert try_accept([row1], [row2], pos_col) is False


def test_try_accept_accepts_independent_rows():
    pos_col = {"a": 0, "b": 2}
    row1 = Row({("a", "x"): 1.0}, 0.5)
    row2 = Row({("b", "y"): 1.0}, 0.25)
    assert try_accept([row1], [row2], pos_col) is True


def test_solve_min_perturbation_moves_only_along_constrained_axis():
    pos_col = {"a": 0}
    x0 = np.array([0.3, 0.7])
    row = Row({("a", "x"): 1.0}, 0.5)
    x_star = solve_min_perturbation([row], pos_col, x0)
    assert x_star[0] == pytest.approx(0.5)
    assert x_star[1] == pytest.approx(0.7)


def test_direct_row_matches_hand_derivation():
    angle = math.radians(30.0)
    direct = DirectPathCandidate(id="direct::a::b", a="a", b="b", angle=angle)
    row = _direct_row(direct)
    n_hat = (-math.sin(angle), math.cos(angle))
    pa, pb = (0.1, 0.2), (0.1 + 0.4 * math.cos(angle) + 0.05, 0.2 + 0.4 * math.sin(angle) - 0.03)
    expected = n_hat[0] * (pb[0] - pa[0]) + n_hat[1] * (pb[1] - pa[1])
    actual = _row_value(row, {"a": pa, "b": pb})
    assert actual == pytest.approx(expected)


def _concurrent_layout():
    """Three flaps and three committed leg directions chosen so all three
    legs genuinely meet at one chosen point -- used to check the concurrency
    row reads exactly 0 there, and that perturbing + re-solving restores it."""
    point = (0.5, 0.4)
    angles = [math.radians(0.0), math.radians(120.0), math.radians(250.0)]
    distances = [0.3, 0.25, 0.35]
    flaps = ["f0", "f1", "f2"]
    positions = {}
    for flap, angle, dist in zip(flaps, angles, distances):
        # Each leg points FROM its flap TOWARD `point`.
        positions[flap] = (point[0] - dist * math.cos(angle), point[1] - dist * math.sin(angle))
    legs = [HalfLeg(id=f"leg::{f}", flap=f, angle=a, point_group_id="p") for f, a in zip(flaps, angles)]
    return legs, positions


def test_concurrency_row_is_zero_at_exact_concurrency():
    legs, positions = _concurrent_layout()
    row = _concurrency_row(*legs)
    assert _row_value(row, positions) == pytest.approx(0.0, abs=1e-9)


def test_concurrency_row_is_nonzero_after_perturbation():
    legs, positions = _concurrent_layout()
    row = _concurrency_row(*legs)
    # f0's leg direction is horizontal (angle 0) -- moving f0 along its own
    # line (in x) leaves that line, and hence concurrency, unchanged; the
    # perturbation needs a component perpendicular to it (in y) to actually
    # break concurrency.
    positions["f0"] = (positions["f0"][0], positions["f0"][1] + 0.05)
    assert abs(_row_value(row, positions)) > 1e-6


def test_solve_restores_concurrency_after_perturbation():
    legs, positions = _concurrent_layout()
    row = _concurrency_row(*legs)
    perturbed = dict(positions)
    perturbed["f0"] = (positions["f0"][0] + 0.05, positions["f0"][1] - 0.02)

    leaf_ids = ["f0", "f1", "f2"]
    pos_col = {leaf_id: 2 * i for i, leaf_id in enumerate(leaf_ids)}
    x0 = np.zeros(6)
    for leaf_id, col in pos_col.items():
        x0[col], x0[col + 1] = perturbed[leaf_id]

    x_star = solve_min_perturbation([row], pos_col, x0)
    solved = {leaf_id: (x_star[col], x_star[col + 1]) for leaf_id, col in pos_col.items()}

    p01 = line_intersection(solved["f0"], legs[0].angle, solved["f1"], legs[1].angle)
    p02 = line_intersection(solved["f0"], legs[0].angle, solved["f2"], legs[2].angle)
    assert p01 is not None and p02 is not None
    assert p01[0] == pytest.approx(p02[0], abs=1e-6)
    assert p01[1] == pytest.approx(p02[1], abs=1e-6)
