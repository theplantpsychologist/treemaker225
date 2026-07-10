import math

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _payload(shape: str = "octagon"):
    """Four leaves off one root: leaf_pair_a/leaf_pair_b sit near the middle
    of the square at a shallow (5-degree) angle from each other, at exactly
    their tree-implied tangency distance -- a clean single active path to
    snap to 0 degrees. leaf_far_left/leaf_far_right sit at the paper's exact
    opposite corners (0,0)/(1,1), decoupling the anchor (min/max x/y) pins
    from the pair actually being snapped, so the result is hand-checkable."""
    scale = 0.4
    len_a, len_b = 0.3, 0.3
    required = scale * (len_a + len_b)
    angle = math.radians(5)
    ax, ay = 0.3, 0.5
    bx, by = ax + required * math.cos(angle), ay + required * math.sin(angle)
    return {
        "tree": {
            "rootId": "root",
            "nodes": [
                {"id": "root", "parentId": None, "length": None},
                {"id": "leaf_pair_a", "parentId": "root", "length": len_a},
                {"id": "leaf_pair_b", "parentId": "root", "length": len_b},
                {"id": "leaf_far_left", "parentId": "root", "length": 0.01},
                {"id": "leaf_far_right", "parentId": "root", "length": 0.01},
            ],
        },
        "hyperparams": {"shape": shape},
        "positions": [
            {"nodeId": "leaf_pair_a", "x": ax, "y": ay},
            {"nodeId": "leaf_pair_b", "x": bx, "y": by},
            {"nodeId": "leaf_far_left", "x": 0.0, "y": 0.0},
            {"nodeId": "leaf_far_right", "x": 1.0, "y": 1.0},
        ],
        "scale": scale,
    }


def test_snap_paths_rejects_circle():
    resp = client.post("/api/snap-paths", json=_payload("circle"))
    assert resp.status_code == 422


def test_snap_paths_rejects_square():
    resp = client.post("/api/snap-paths", json=_payload("square"))
    assert resp.status_code == 422


def test_snap_paths_no_op_when_nothing_is_active():
    payload = _payload()
    # Push leaf_pair_b far away so neither the length nor the angle
    # condition holds anymore.
    payload["positions"][1] = {"nodeId": "leaf_pair_b", "x": 0.31, "y": 0.99}
    resp = client.post("/api/snap-paths", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["snappedCount"] == 0
    assert body["leafPositions"] == []
    assert body["lengths"] == []


def test_snap_paths_end_to_end_snaps_angle_and_preserves_anchors():
    resp = client.post("/api/snap-paths", json=_payload())
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["snappedCount"] == 1

    positions = {p["nodeId"]: (p["x"], p["y"]) for p in body["leafPositions"]}
    lengths = {n["nodeId"]: n["length"] for n in body["lengths"]}

    # Decoy anchors were already exactly at their pinned corners, so the
    # least-squares solve should leave them untouched (to floating-point
    # noise from the shared weighted linear solve).
    assert positions["leaf_far_left"] == pytest.approx((0.0, 0.0), abs=1e-8)
    assert positions["leaf_far_right"] == pytest.approx((1.0, 1.0), abs=1e-8)
    assert lengths["leaf_far_left"] == pytest.approx(0.01, abs=1e-8)
    assert lengths["leaf_far_right"] == pytest.approx(0.01, abs=1e-8)

    # The snapped pair should now share the same y (angle == 0).
    ax, ay = positions["leaf_pair_a"]
    bx, by = positions["leaf_pair_b"]
    assert math.isclose(ay, by, abs_tol=1e-3)
    assert bx > ax

    # The (now horizontal) distance between them should equal scale times
    # the sum of their snapped lengths.
    scale = 0.4
    new_len_sum = lengths["leaf_pair_a"] + lengths["leaf_pair_b"]
    assert math.isclose(bx - ax, scale * new_len_sum, abs_tol=1e-3)
    assert lengths["leaf_pair_a"] > 0
    assert lengths["leaf_pair_b"] > 0
