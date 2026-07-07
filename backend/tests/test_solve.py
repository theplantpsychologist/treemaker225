import math

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _star_tree_payload(n_restarts: int = 15):
    """A root with 3 equal-length leaf children, plus one internal branch node
    that itself has 2 leaf children. Mirrors the prototype's example shape."""
    return {
        "tree": {
            "rootId": "root",
            "nodes": [
                {"id": "root", "parentId": None, "length": None},
                {"id": "leaf_a", "parentId": "root", "length": 3},
                {"id": "leaf_b", "parentId": "root", "length": 3},
                {"id": "branch", "parentId": "root", "length": 6},
                {"id": "leaf_c", "parentId": "branch", "length": 3},
                {"id": "leaf_d", "parentId": "branch", "length": 3},
            ],
        },
        "hyperparams": {"nRestarts": n_restarts, "seed": 42},
    }


def test_health():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_solve_returns_one_position_per_leaf():
    resp = client.post("/api/solve", json=_star_tree_payload())
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    leaf_ids = {p["nodeId"] for p in body["leafPositions"]}
    assert leaf_ids == {"leaf_a", "leaf_b", "leaf_c", "leaf_d"}
    assert body["scale"] > 0


def test_solve_result_has_no_pairwise_overlaps():
    resp = client.post("/api/solve", json=_star_tree_payload(n_restarts=30))
    body = resp.json()
    scale = body["scale"]
    positions = {p["nodeId"]: (p["x"], p["y"]) for p in body["leafPositions"]}

    tree_distances = {
        ("leaf_a", "leaf_b"): 6,
        ("leaf_a", "leaf_c"): 12,
        ("leaf_a", "leaf_d"): 12,
        ("leaf_b", "leaf_c"): 12,
        ("leaf_b", "leaf_d"): 12,
        ("leaf_c", "leaf_d"): 6,
    }
    for (a, b), dist in tree_distances.items():
        ax, ay = positions[a]
        bx, by = positions[b]
        actual = math.hypot(ax - bx, ay - by)
        assert actual >= scale * dist - 1e-4


def test_solve_rejects_malformed_tree():
    payload = _star_tree_payload()
    payload["tree"]["nodes"].append({"id": "orphan", "parentId": "does-not-exist", "length": 1})
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 422


def test_solve_shape_refinement_returns_internal_positions():
    payload = _star_tree_payload(n_restarts=20)
    payload["hyperparams"]["nRefine"] = 5
    payload["hyperparams"]["shape"] = "octagon"
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["diagnostics"]["bestScaleRefined"] is not None
    # shape-refined packing is at least as conservative as circle packing (smaller or equal scale)
    assert body["diagnostics"]["bestScaleRefined"] <= body["diagnostics"]["bestScaleCircle"] + 1e-6
    internal_ids = {p["nodeId"] for p in body["internalPositions"]}
    assert internal_ids == {"root", "branch"}


def test_solve_circle_skips_refinement():
    payload = _star_tree_payload(n_restarts=15)
    payload["hyperparams"]["shape"] = "circle"
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["diagnostics"]["bestScaleRefined"] is None


_TREE_DISTANCES = {
    ("leaf_a", "leaf_b"): 6,
    ("leaf_a", "leaf_c"): 12,
    ("leaf_a", "leaf_d"): 12,
    ("leaf_b", "leaf_c"): 12,
    ("leaf_b", "leaf_d"): 12,
    ("leaf_c", "leaf_d"): 6,
}


def _regular_ngon_bases(n: int, angle_offset: float = 0.0):
    return [
        (math.cos(angle_offset + 2 * math.pi * k / n), math.sin(angle_offset + 2 * math.pi * k / n))
        for k in range(n)
    ]


_SHAPE_BASES = {
    "square": _regular_ngon_bases(4),
    "hexagon": _regular_ngon_bases(6, angle_offset=math.pi / 2),
    "octagon": _regular_ngon_bases(8),
    "dodecagon": _regular_ngon_bases(12),
}


def _assert_no_pairwise_overlaps(body, bases):
    scale = body["scale"]
    positions = {p["nodeId"]: (p["x"], p["y"]) for p in body["leafPositions"]}
    for (a, b), dist in _TREE_DISTANCES.items():
        ax, ay = positions[a]
        bx, by = positions[b]
        dx, dy = ax - bx, ay - by
        if bases is None:
            sep = math.hypot(dx, dy)
        else:
            sep = max(dx * ox + dy * oy for ox, oy in bases)
        assert sep >= scale * dist - 1e-3


def test_solve_octagon_result_has_no_pairwise_overlaps():
    payload = _star_tree_payload(n_restarts=25)
    payload["hyperparams"]["nRefine"] = 8
    payload["hyperparams"]["shape"] = "octagon"
    resp = client.post("/api/solve", json=payload)
    _assert_no_pairwise_overlaps(resp.json(), _SHAPE_BASES["octagon"])


def test_solve_square_result_has_no_pairwise_overlaps():
    payload = _star_tree_payload(n_restarts=25)
    payload["hyperparams"]["nRefine"] = 8
    payload["hyperparams"]["shape"] = "square"
    resp = client.post("/api/solve", json=payload)
    _assert_no_pairwise_overlaps(resp.json(), _SHAPE_BASES["square"])


def test_solve_hexagon_result_has_no_pairwise_overlaps():
    payload = _star_tree_payload(n_restarts=25)
    payload["hyperparams"]["nRefine"] = 8
    payload["hyperparams"]["shape"] = "hexagon"
    resp = client.post("/api/solve", json=payload)
    _assert_no_pairwise_overlaps(resp.json(), _SHAPE_BASES["hexagon"])


def test_solve_dodecagon_result_has_no_pairwise_overlaps():
    payload = _star_tree_payload(n_restarts=25)
    payload["hyperparams"]["nRefine"] = 8
    payload["hyperparams"]["shape"] = "dodecagon"
    resp = client.post("/api/solve", json=payload)
    _assert_no_pairwise_overlaps(resp.json(), _SHAPE_BASES["dodecagon"])


def test_solve_circle_result_has_no_pairwise_overlaps():
    payload = _star_tree_payload(n_restarts=25)
    payload["hyperparams"]["shape"] = "circle"
    resp = client.post("/api/solve", json=payload)
    _assert_no_pairwise_overlaps(resp.json(), None)
