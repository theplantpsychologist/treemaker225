from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _tree_payload():
    return {
        "tree": {
            "rootId": "root",
            "nodes": [
                {"id": "root", "parentId": None, "length": None},
                {"id": "leaf_a", "parentId": "root", "length": 3},
                {"id": "leaf_b", "parentId": "root", "length": 5},
                {"id": "leaf_c", "parentId": "root", "length": 4},
            ],
        },
        "hyperparams": {"nRestarts": 15, "runOctagonRefinement": False, "seed": 3},
    }


def test_init_from_current_uses_a_single_restart():
    payload = _tree_payload()
    payload["initFrom"] = "current"
    payload["currentPositions"] = [
        {"nodeId": "leaf_a", "x": 0.1, "y": 0.1},
        {"nodeId": "leaf_b", "x": 0.9, "y": 0.1},
        {"nodeId": "leaf_c", "x": 0.5, "y": 0.9},
    ]
    payload["currentScale"] = 0.01
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["diagnostics"]["restartsAttempted"] == 1


def test_init_from_current_requires_positions_and_scale():
    payload = _tree_payload()
    payload["initFrom"] = "current"
    resp = client.post("/api/solve", json=payload)
    assert resp.status_code == 422
