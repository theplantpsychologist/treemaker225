import math

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

# Keep the solve fast for tests -- one basin-hopping restart, few anneal
# outer iterations. Restart 0 (the exact given seed) is always attempted
# regardless, so correctness isn't sacrificed for speed here.
_FAST_HYPERPARAMS = {
    "pathNetworkNRestarts": 1,
    "pathNetworkAnnealOuterIters": 3,
}


def _four_leaf_loop_payload(shape: str = "octagon", equal_pairs=None):
    """Four leaves arranged so each direct pair is already exactly tangent
    and axis-aligned in the initial layout -- a-b at 0 degrees, b-c at 90,
    c-d at 0 (mirrored), d-a at 90 (mirrored) -- forming a closed loop where
    every flap already has two clean direct-path candidates. This keeps the
    preprocessing free of any indirect/ambiguous candidates so the test is
    easy to reason about."""
    scale = 0.15
    lens = {"a": 0.5, "b": 0.5, "c": 0.5, "d": 0.5}
    side = scale * (lens["a"] + lens["b"])  # same magnitude reused for every side
    ax, ay = 0.2, 0.2
    bx, by = ax + side, ay
    cx, cy = bx, by + side
    dx, dy = ax, ay + side
    tree = {
        "rootId": "root",
        "nodes": [
            {"id": "root", "parentId": None, "length": None},
            {"id": "a", "parentId": "root", "length": lens["a"]},
            {"id": "b", "parentId": "root", "length": lens["b"]},
            {"id": "c", "parentId": "root", "length": lens["c"]},
            {"id": "d", "parentId": "root", "length": lens["d"]},
        ],
    }
    constraints = {"equalPairs": equal_pairs} if equal_pairs else {}
    return {
        "tree": tree,
        "constraints": constraints,
        "hyperparams": {"shape": shape, **_FAST_HYPERPARAMS},
        "positions": [
            {"nodeId": "a", "x": ax, "y": ay},
            {"nodeId": "b", "x": bx, "y": by},
            {"nodeId": "c", "x": cx, "y": cy},
            {"nodeId": "d", "x": dx, "y": dy},
        ],
        "scale": scale,
    }


def test_path_network_snap_rejects_circle():
    resp = client.post("/api/path-network-snap", json=_four_leaf_loop_payload("circle"))
    assert resp.status_code == 422


def test_path_network_snap_rejects_square():
    resp = client.post("/api/path-network-snap", json=_four_leaf_loop_payload("square"))
    assert resp.status_code == 422


def test_path_network_snap_end_to_end_selects_the_clean_loop():
    # There's no hard per-flap degree requirement anymore -- selection is
    # driven entirely by the count-maximizing objective, which just happens
    # to prefer selecting all 4 already-clean direct paths here since that
    # maximizes the count.
    resp = client.post("/api/path-network-snap", json=_four_leaf_loop_payload())
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert len(body["leafPositions"]) == 4
    assert len(body["lengths"]) == 4

    degree = {leaf: 0 for leaf in ("a", "b", "c", "d")}
    for path in body["selectedDirectPaths"]:
        degree[path["a"]] += 1
        degree[path["b"]] += 1
    leg_counts: dict = {}
    for leg in body["selectedLegs"]:
        degree[leg["flap"]] += 1
        leg_counts.setdefault(leg["pointId"], 0)
        leg_counts[leg["pointId"]] += 1

    for leaf, count in degree.items():
        assert count >= 2, f"flap {leaf} only has degree {count}"

    # No dangling intermediate point (exactly one leg at a shared point).
    for point_id, count in leg_counts.items():
        assert count != 1, f"point {point_id} is dangling with exactly one leg"

    lengths = {n["nodeId"]: n["length"] for n in body["lengths"]}
    for length in lengths.values():
        assert length >= 0.0


def test_path_network_snap_caps_length_growth_for_an_isolated_leaf():
    # A 5th leaf placed far from the whole a-b-c-d cluster has every one of
    # its pairs pruned from the non-overlap check (see path_network.py's
    # far_pairs) -- before the growth-cap fix, this length had nothing at
    # all bounding it from above, and a nonzero pathNetworkC2 (the default)
    # created a genuine incentive to blow it up without limit. The growth
    # cap is a hard box bound, so it must hold regardless of convergence.
    payload = _four_leaf_loop_payload()
    payload["tree"]["nodes"].append({"id": "e", "parentId": "root", "length": 0.3})
    payload["positions"].append({"nodeId": "e", "x": 0.9, "y": 0.9})
    growth_cap = 3.0
    payload["hyperparams"]["pathNetworkGrowthCap"] = growth_cap

    resp = client.post("/api/path-network-snap", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    lengths = {n["nodeId"]: n["length"] for n in body["lengths"]}
    assert lengths["e"] <= 0.3 * growth_cap + 1e-6


def test_path_network_snap_isolated_leaf_no_longer_blocks_convergence():
    # Before the hard per-flap degree>=2 constraint was removed, a leaf with
    # zero candidate paths at all (like "e" here) made the whole NLP
    # infeasible -- there was no boolean variable that could ever satisfy
    # its degree requirement. With selection now driven by the count-
    # maximizing objective instead, "e" just ends up with no selected paths
    # of its own while the rest of the tree still solves cleanly.
    payload = _four_leaf_loop_payload()
    payload["tree"]["nodes"].append({"id": "e", "parentId": "root", "length": 0.3})
    payload["positions"].append({"nodeId": "e", "x": 0.9, "y": 0.9})

    resp = client.post("/api/path-network-snap", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["message"] is None

    selected_flaps = set()
    for path in body["selectedDirectPaths"]:
        selected_flaps.add(path["a"])
        selected_flaps.add(path["b"])
    for leg in body["selectedLegs"]:
        selected_flaps.add(leg["flap"])
    assert "e" not in selected_flaps
    assert {"a", "b", "c", "d"} <= selected_flaps


def test_path_network_snap_respects_equal_pairs():
    resp = client.post(
        "/api/path-network-snap", json=_four_leaf_loop_payload(equal_pairs={"a": "c", "c": "a"})
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    lengths = {n["nodeId"]: n["length"] for n in body["lengths"]}
    assert math.isclose(lengths["a"], lengths["c"], abs_tol=1e-4)
