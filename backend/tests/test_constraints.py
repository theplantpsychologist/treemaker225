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
        "hyperparams": {"nRestarts": n_restarts, "runOctagonRefinement": False, "seed": 7},
    }


def test_pin_symmetry_book_keeps_leaf_on_center_line():
    payload = _tree_payload({"leaf_a": {"kind": "pin_symmetry"}}, symmetry_mode="book")
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    pos = next(p for p in body["leafPositions"] if p["nodeId"] == "leaf_a")
    assert abs(pos["x"] - 0.5) < 1e-6


def test_pin_symmetry_diagonal_keeps_leaf_on_diagonal():
    payload = _tree_payload({"leaf_a": {"kind": "pin_symmetry"}}, symmetry_mode="diagonal")
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    pos = next(p for p in body["leafPositions"] if p["nodeId"] == "leaf_a")
    assert abs(pos["x"] - pos["y"]) < 1e-6


def test_pair_mirrors_positions_and_averages_lengths():
    payload = _tree_payload(
        {
            "leaf_a": {"kind": "pair", "pairedWith": "leaf_b"},
            "leaf_b": {"kind": "pair", "pairedWith": "leaf_a"},
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
    payload = _tree_payload({"leaf_a": {"kind": "pin_edge", "edge": "left"}})
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    pos = next(p for p in body["leafPositions"] if p["nodeId"] == "leaf_a")
    assert abs(pos["x"] - 0.0) < 1e-9


def test_pin_corner_fixes_exact_point():
    payload = _tree_payload({"leaf_a": {"kind": "pin_corner", "corner": "bottom_right"}})
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    pos = next(p for p in body["leafPositions"] if p["nodeId"] == "leaf_a")
    assert abs(pos["x"] - 1.0) < 1e-9
    assert abs(pos["y"] - 1.0) < 1e-9


def test_pair_without_symmetry_mode_is_rejected():
    payload = _tree_payload(
        {
            "leaf_a": {"kind": "pair", "pairedWith": "leaf_b"},
            "leaf_b": {"kind": "pair", "pairedWith": "leaf_a"},
        },
        symmetry_mode="none",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 422


def test_non_mutual_pair_is_rejected():
    payload = _tree_payload(
        {"leaf_a": {"kind": "pair", "pairedWith": "leaf_b"}},
        symmetry_mode="book",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 422


def test_double_pairing_is_rejected():
    payload = _tree_payload(
        {
            "leaf_a": {"kind": "pair", "pairedWith": "leaf_c"},
            "leaf_b": {"kind": "pair", "pairedWith": "leaf_c"},
            "leaf_c": {"kind": "pair", "pairedWith": "leaf_a"},
        },
        symmetry_mode="book",
    )
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 422
