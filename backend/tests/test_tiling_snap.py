import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _star_payload(extra_isolated_leaf: bool = False):
    """A center flap surrounded by 4 cardinal flaps -- center is strictly
    interior (needs degree>=2 via selected paths), n/s/e/w are all on the
    convex hull (exempt, and each gets auto-pinned to its nearest edge)."""
    scale = 0.1
    cx, cy = 0.5, 0.5
    nodes = [
        {"id": "root", "parentId": None, "length": None},
        {"id": "center", "parentId": "root", "length": 0.5},
        {"id": "n", "parentId": "root", "length": 0.5},
        {"id": "s", "parentId": "root", "length": 0.5},
        {"id": "e", "parentId": "root", "length": 0.5},
        {"id": "w", "parentId": "root", "length": 0.5},
    ]
    positions = [
        {"nodeId": "center", "x": cx, "y": cy},
        {"nodeId": "n", "x": cx, "y": cy + 0.1},
        {"nodeId": "s", "x": cx, "y": cy - 0.1},
        {"nodeId": "e", "x": cx + 0.1, "y": cy},
        {"nodeId": "w", "x": cx - 0.1, "y": cy},
    ]
    if extra_isolated_leaf:
        nodes.append({"id": "far", "parentId": "root", "length": 0.3})
        positions.append({"nodeId": "far", "x": 0.95, "y": 0.95})
    return {
        "tree": {"rootId": "root", "nodes": nodes},
        "constraints": {},
        "hyperparams": {"shape": "octagon"},
        "positions": positions,
        "scale": scale,
    }


def test_tiling_snap_rejects_circle():
    payload = _star_payload()
    payload["hyperparams"]["shape"] = "circle"
    resp = client.post("/api/tiling-snap", json=payload)
    assert resp.status_code == 422


def test_tiling_snap_rejects_square():
    payload = _star_payload()
    payload["hyperparams"]["shape"] = "square"
    resp = client.post("/api/tiling-snap", json=payload)
    assert resp.status_code == 422


def test_tiling_snap_pins_hull_leaves_and_satisfies_interior_degree():
    resp = client.post("/api/tiling-snap", json=_star_payload())
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["message"] is None
    assert "lengths" not in body

    positions = {p["nodeId"]: (p["x"], p["y"]) for p in body["leafPositions"]}
    assert positions["n"][1] == pytest.approx(1.0)
    assert positions["s"][1] == pytest.approx(0.0)
    assert positions["e"][0] == pytest.approx(1.0)
    assert positions["w"][0] == pytest.approx(0.0)

    degree = {"center": 0, "n": 0, "s": 0, "e": 0, "w": 0}
    for path in body["selectedDirectPaths"]:
        degree[path["a"]] += 1
        degree[path["b"]] += 1
    for vertex in body["vertices"]:
        for leg in vertex["legs"]:
            degree[leg["flap"]] += 1
    assert degree["center"] >= 2

    # Root is the tree's only non-leaf node -- it gets a fitted position for
    # river rendering even though this tiny star has no real rivers.
    assert len(body["internalPositions"]) == 1
    assert body["internalPositions"][0]["nodeId"] == "root"


def test_tiling_snap_handles_isolated_leaf_without_error():
    resp = client.post("/api/tiling-snap", json=_star_payload(extra_isolated_leaf=True))
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["message"] is None

    touched_flaps = set()
    for path in body["selectedDirectPaths"]:
        touched_flaps.add(path["a"])
        touched_flaps.add(path["b"])
    for vertex in body["vertices"]:
        for leg in vertex["legs"]:
            touched_flaps.add(leg["flap"])
    assert "far" not in touched_flaps
