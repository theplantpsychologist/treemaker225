from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _tree_payload(extra_constraints=None, symmetry_mode="none", n_restarts=20):
    return {
        "tree": {
            "rootId": "root",
            "nodes": [
                {"id": "root", "parentId": None, "length": None},
                {"id": "leaf_a", "parentId": "root", "length": 3},
                {"id": "leaf_b", "parentId": "root", "length": 5},
                {"id": "leaf_c", "parentId": "root", "length": 4},
                {"id": "leaf_d", "parentId": "root", "length": 4},
            ],
        },
        "constraints": {
            "symmetryMode": symmetry_mode,
            "perLeaf": extra_constraints or {},
        },
        "hyperparams": {"nRestarts": n_restarts, "shape": "circle", "seed": 7},
    }


def _sym(kind, **kwargs):
    return {"kind": kind, **kwargs}


def _bnd(kind, **kwargs):
    return {"kind": kind, **kwargs}


def _lock(kind, **kwargs):
    return {"kind": kind, **kwargs}


def test_pin_symmetry_book_keeps_leaf_on_center_line():
    payload = _tree_payload({"leaf_a": {"symmetry": _sym("pin_symmetry")}}, symmetry_mode="book")
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    pos = next(p for p in body["leafPositions"] if p["nodeId"] == "leaf_a")
    assert abs(pos["x"] - 0.5) < 1e-6


def test_pin_symmetry_diagonal_keeps_leaf_on_diagonal():
    payload = _tree_payload({"leaf_a": {"symmetry": _sym("pin_symmetry")}}, symmetry_mode="diagonal")
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    pos = next(p for p in body["leafPositions"] if p["nodeId"] == "leaf_a")
    assert abs(pos["x"] - pos["y"]) < 1e-6


def test_pair_mirrors_positions_and_averages_lengths():
    payload = _tree_payload(
        {
            "leaf_a": {"symmetry": _sym("pair", pairedWith="leaf_b")},
            "leaf_b": {"symmetry": _sym("pair", pairedWith="leaf_a")},
        },
        symmetry_mode="book",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    positions = {p["nodeId"]: (p["x"], p["y"]) for p in body["leafPositions"]}
    ax, ay = positions["leaf_a"]
    bx, by = positions["leaf_b"]
    assert abs((1 - ax) - bx) < 1e-6
    assert abs(ay - by) < 1e-6


def test_pin_edge_fixes_perpendicular_coordinate():
    payload = _tree_payload({"leaf_a": {"boundary": _bnd("pin_edge", edge="left")}})
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    pos = next(p for p in body["leafPositions"] if p["nodeId"] == "leaf_a")
    assert abs(pos["x"] - 0.0) < 1e-9


def test_pin_corner_fixes_exact_point():
    # The unit square is y-up (bottom_right = (1, 0)) — see constraint_resolution.py.
    payload = _tree_payload({"leaf_a": {"boundary": _bnd("pin_corner", corner="bottom_right")}})
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    pos = next(p for p in body["leafPositions"] if p["nodeId"] == "leaf_a")
    assert abs(pos["x"] - 1.0) < 1e-9
    assert abs(pos["y"] - 0.0) < 1e-9


def test_pair_without_symmetry_mode_is_rejected():
    payload = _tree_payload(
        {
            "leaf_a": {"symmetry": _sym("pair", pairedWith="leaf_b")},
            "leaf_b": {"symmetry": _sym("pair", pairedWith="leaf_a")},
        },
        symmetry_mode="none",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 422


def test_non_mutual_pair_is_rejected():
    payload = _tree_payload(
        {"leaf_a": {"symmetry": _sym("pair", pairedWith="leaf_b")}},
        symmetry_mode="book",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 422


def test_double_pairing_is_rejected():
    payload = _tree_payload(
        {
            "leaf_a": {"symmetry": _sym("pair", pairedWith="leaf_c")},
            "leaf_b": {"symmetry": _sym("pair", pairedWith="leaf_c")},
            "leaf_c": {"symmetry": _sym("pair", pairedWith="leaf_a")},
        },
        symmetry_mode="book",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 422


def test_two_leaves_pinned_to_same_corner_is_rejected():
    payload = _tree_payload(
        {
            "leaf_a": {"boundary": _bnd("pin_corner", corner="bottom_right")},
            "leaf_b": {"boundary": _bnd("pin_corner", corner="bottom_right")},
        },
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 422


def test_book_symmetry_with_left_edge_pin_is_infeasible():
    payload = _tree_payload(
        {"leaf_a": {"symmetry": _sym("pin_symmetry"), "boundary": _bnd("pin_edge", edge="left")}},
        symmetry_mode="book",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 422


def test_diagonal_symmetry_with_top_edge_pin_collapses_to_top_right_corner():
    # The diagonal line x=y passes through top_right/bottom_left in this
    # y-up unit square (see constraint_resolution.py's _diagonal_corner).
    payload = _tree_payload(
        {"leaf_a": {"symmetry": _sym("pin_symmetry"), "boundary": _bnd("pin_edge", edge="top")}},
        symmetry_mode="diagonal",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    pos = next(p for p in body["leafPositions"] if p["nodeId"] == "leaf_a")
    assert abs(pos["x"] - 1.0) < 1e-9
    assert abs(pos["y"] - 1.0) < 1e-9


def test_diagonal_edge_pin_collision_with_direct_corner_pin_is_rejected():
    payload = _tree_payload(
        {
            "leaf_a": {"symmetry": _sym("pin_symmetry"), "boundary": _bnd("pin_edge", edge="top")},
            "leaf_b": {"boundary": _bnd("pin_corner", corner="top_right")},
        },
        symmetry_mode="diagonal",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 422


def test_pair_with_mismatched_boundary_pins_is_rejected():
    # Under book symmetry, 'left' mirrors to 'right', not 'top' — these two
    # pins are not consistent with each other, so this must be rejected.
    payload = _tree_payload(
        {
            "leaf_a": {
                "symmetry": _sym("pair", pairedWith="leaf_b"),
                "boundary": _bnd("pin_edge", edge="left"),
            },
            "leaf_b": {
                "symmetry": _sym("pair", pairedWith="leaf_a"),
                "boundary": _bnd("pin_edge", edge="top"),
            },
        },
        symmetry_mode="book",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 422


def test_pair_with_correctly_mirrored_boundary_pins_is_accepted():
    # Under book symmetry, 'left' mirrors to 'right' — both sides carrying
    # their own (mutually consistent) mirrored pin is allowed.
    payload = _tree_payload(
        {
            "leaf_a": {
                "symmetry": _sym("pair", pairedWith="leaf_b"),
                "boundary": _bnd("pin_edge", edge="left"),
            },
            "leaf_b": {
                "symmetry": _sym("pair", pairedWith="leaf_a"),
                "boundary": _bnd("pin_edge", edge="right"),
            },
        },
        symmetry_mode="book",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    positions = {p["nodeId"]: (p["x"], p["y"]) for p in body["leafPositions"]}
    ax, ay = positions["leaf_a"]
    bx, by = positions["leaf_b"]
    assert abs(ax - 0.0) < 1e-9
    assert abs(bx - 1.0) < 1e-9
    assert abs(ay - by) < 1e-9


def test_pair_leader_corner_pin_mirrors_to_a_colliding_third_leaf_is_rejected():
    # leaf_a paired with leaf_b, leaf_a pinned to top_left -> leaf_b mirrors
    # (book: 1-x,y) to top_right. leaf_c independently pinned to top_right
    # collides with that mirrored point.
    payload = _tree_payload(
        {
            "leaf_a": {
                "symmetry": _sym("pair", pairedWith="leaf_b"),
                "boundary": _bnd("pin_corner", corner="top_left"),
            },
            "leaf_b": {"symmetry": _sym("pair", pairedWith="leaf_a")},
            "leaf_c": {"boundary": _bnd("pin_corner", corner="top_right")},
        },
        symmetry_mode="book",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 422


def test_pair_leader_with_boundary_pin_mirrors_correctly():
    payload = _tree_payload(
        {
            "leaf_a": {
                "symmetry": _sym("pair", pairedWith="leaf_b"),
                "boundary": _bnd("pin_corner", corner="top_left"),
            },
            "leaf_b": {"symmetry": _sym("pair", pairedWith="leaf_a")},
        },
        symmetry_mode="book",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    positions = {p["nodeId"]: (p["x"], p["y"]) for p in body["leafPositions"]}
    ax, ay = positions["leaf_a"]
    bx, by = positions["leaf_b"]
    assert abs(ax - 0.0) < 1e-9 and abs(ay - 1.0) < 1e-9
    assert abs(bx - 1.0) < 1e-9 and abs(by - 1.0) < 1e-9


def test_locked_leaf_solves_to_exactly_its_snapshot_point():
    payload = _tree_payload({"leaf_a": {"locked": _lock("locked", point={"x": 0.3, "y": 0.7})}})
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    pos = next(p for p in body["leafPositions"] if p["nodeId"] == "leaf_a")
    assert abs(pos["x"] - 0.3) < 1e-9
    assert abs(pos["y"] - 0.7) < 1e-9


def test_locked_leaf_in_a_pair_mirrors_to_its_partner():
    payload = _tree_payload(
        {
            "leaf_a": {
                "symmetry": _sym("pair", pairedWith="leaf_b"),
                "locked": _lock("locked", point={"x": 0.2, "y": 0.4}),
            },
            "leaf_b": {"symmetry": _sym("pair", pairedWith="leaf_a")},
        },
        symmetry_mode="book",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    positions = {p["nodeId"]: (p["x"], p["y"]) for p in body["leafPositions"]}
    assert abs(positions["leaf_a"][0] - 0.2) < 1e-9 and abs(positions["leaf_a"][1] - 0.4) < 1e-9
    assert abs(positions["leaf_b"][0] - 0.8) < 1e-9 and abs(positions["leaf_b"][1] - 0.4) < 1e-9


def test_locked_leaf_with_no_point_is_rejected():
    payload = _tree_payload({"leaf_a": {"locked": _lock("locked")}})
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 422


def test_pair_non_leader_locked_independently_is_rejected():
    # leaf_b > leaf_a lexicographically, so leaf_b is the non-leader half of
    # the pair and can't carry its own independent lock.
    payload = _tree_payload(
        {
            "leaf_a": {"symmetry": _sym("pair", pairedWith="leaf_b")},
            "leaf_b": {
                "symmetry": _sym("pair", pairedWith="leaf_a"),
                "locked": _lock("locked", point={"x": 0.2, "y": 0.4}),
            },
        },
        symmetry_mode="book",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 422
