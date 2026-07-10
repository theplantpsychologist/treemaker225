import math

from app.core.shapes import get_bases


def _angle_offset(bases):
    return math.atan2(bases[0][1], bases[0][0]) % (2 * math.pi)


def test_hexagon_base_orientation_is_vertical_face_normal():
    bases = get_bases("hexagon")
    assert math.isclose(_angle_offset(bases), math.pi / 2, abs_tol=1e-9)


def test_hexagon_diagonal_symmetry_rotates_45_degrees():
    bases = get_bases("hexagon", symmetry_mode="diagonal")
    assert math.isclose(_angle_offset(bases), math.pi / 2 + math.pi / 4, abs_tol=1e-9)


def test_hexagon_extra_rotation_adds_90_degrees():
    bases = get_bases("hexagon", extra_rotation=True)
    assert math.isclose(_angle_offset(bases), math.pi / 2 + math.pi / 2, abs_tol=1e-9)


def test_hexagon_diagonal_and_extra_rotation_compose():
    bases = get_bases("hexagon", symmetry_mode="diagonal", extra_rotation=True)
    expected = (math.pi / 2 + math.pi / 4 + math.pi / 2) % (2 * math.pi)
    assert math.isclose(_angle_offset(bases), expected, abs_tol=1e-9)


def test_other_shapes_ignore_symmetry_and_rotation_args():
    assert get_bases("octagon") == get_bases("octagon", symmetry_mode="diagonal", extra_rotation=True)
    assert get_bases("circle", symmetry_mode="diagonal", extra_rotation=True) is None


def test_square_base_orientation_is_axis_aligned():
    bases = get_bases("square")
    assert math.isclose(_angle_offset(bases), 0.0, abs_tol=1e-9)


def test_square_extra_rotation_adds_45_degrees():
    bases = get_bases("square", extra_rotation=True)
    assert math.isclose(_angle_offset(bases), math.pi / 4, abs_tol=1e-9)


def test_square_ignores_symmetry_mode():
    # Unlike hexagon, square's 45-degree rotation is purely the manual
    # extra_rotation toggle -- any "default to rotated when diagonal" logic
    # lives at the frontend store's call site, not in get_bases itself.
    assert get_bases("square", symmetry_mode="diagonal") == get_bases("square")
    assert get_bases("square", symmetry_mode="diagonal", extra_rotation=True) == get_bases(
        "square", extra_rotation=True
    )


def test_dodecagon_base_orientation_is_axis_aligned():
    bases = get_bases("dodecagon")
    assert math.isclose(_angle_offset(bases), 0.0, abs_tol=1e-9)


def test_dodecagon_extra_rotation_adds_15_degrees():
    bases = get_bases("dodecagon", extra_rotation=True)
    assert math.isclose(_angle_offset(bases), math.pi / 12, abs_tol=1e-9)


def test_dodecagon_ignores_symmetry_mode():
    # Same mechanism as square: dodecagon's 15-degree rotation is purely the
    # manual extra_rotation toggle -- any "default to rotated when diagonal"
    # logic lives at the frontend store's call site, not in get_bases itself.
    assert get_bases("dodecagon", symmetry_mode="diagonal") == get_bases("dodecagon")
    assert get_bases("dodecagon", symmetry_mode="diagonal", extra_rotation=True) == get_bases(
        "dodecagon", extra_rotation=True
    )
