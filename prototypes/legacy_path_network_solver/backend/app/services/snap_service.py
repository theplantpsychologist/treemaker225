from typing import Dict, List, Tuple

import numpy as np

from app.core.active_paths import compute_active_paths
from app.core.path_snapping import (
    MIN_LENGTH,
    VariableIndex,
    build_anchor_constraints,
    build_angle_constraints,
    build_length_constraints,
    solve_snap,
)
from app.core.shapes import extra_rotation_for
from app.core.tree import build_tree, get_leaves
from app.schemas.snap import NodeLengthOut, SnapPathsRequest, SnapPathsResponse
from app.schemas.solve import NodePositionOut

# Only these shapes have discrete face-normal directions worth snapping a
# path's angle to that aren't already handled some other way -- circle has
# no discrete angle at all, and square is explicitly out of scope for now
# per the user's request (both are rejected below, not silently no-op'd).
SNAPPABLE_SHAPES = {"hexagon", "octagon", "dodecagon"}


def snap_active_paths(req: SnapPathsRequest) -> SnapPathsResponse:
    hp = req.hyperparams
    if hp.shape not in SNAPPABLE_SHAPES:
        raise ValueError(f"path snapping isn't supported for shape '{hp.shape}' yet")

    tree = build_tree(req.tree)
    leaf_ids = get_leaves(tree)
    length_ids = [node_id for node_id in tree.nodes if node_id != req.tree.root_id]
    positions: Dict[str, Tuple[float, float]] = {p.node_id: (p.x, p.y) for p in req.positions}

    missing = [leaf_id for leaf_id in leaf_ids if leaf_id not in positions]
    if missing:
        raise ValueError(f"missing current position for leaf(s): {', '.join(missing)}")

    extra_rotation = extra_rotation_for(
        hp.shape, hp.hexagon_extra_rotation, hp.square_extra_rotation, hp.dodecagon_extra_rotation
    )
    active_paths = compute_active_paths(
        tree,
        leaf_ids,
        positions,
        req.scale,
        hp.shape,
        req.constraints.symmetry_mode,
        extra_rotation,
        hp.active_snap_length_tolerance,
        hp.active_snap_angle_tolerance,
    )
    if not active_paths:
        return SnapPathsResponse(status="ok", leaf_positions=[], lengths=[], snapped_count=0)

    index = VariableIndex.build(leaf_ids, length_ids)
    x0 = np.zeros(index.n_cols)
    for leaf_id in leaf_ids:
        px, py = positions[leaf_id]
        x0[index.pos_col[leaf_id]] = px
        x0[index.pos_col[leaf_id] + 1] = py
    for node_id in length_ids:
        parent_id = next(tree.predecessors(node_id))
        x0[index.length_col[node_id]] = tree.edges[parent_id, node_id]["length"]

    a_angle, b_angle = build_angle_constraints(active_paths, index)
    a_length, b_length = build_length_constraints(active_paths, index, tree, req.scale)
    a_anchor, b_anchor = build_anchor_constraints(leaf_ids, positions, index)
    a = np.vstack([a_angle, a_length, a_anchor])
    b = np.concatenate([b_angle, b_length, b_anchor])

    lower = np.zeros(index.n_cols)
    upper = np.ones(index.n_cols)
    length_cols = [index.length_col[node_id] for node_id in length_ids]
    lower[length_cols] = MIN_LENGTH
    upper[length_cols] = np.inf

    x = solve_snap(x0, a, b, lower, upper)

    leaf_positions: List[NodePositionOut] = [
        NodePositionOut(node_id=leaf_id, x=float(x[index.pos_col[leaf_id]]), y=float(x[index.pos_col[leaf_id] + 1]))
        for leaf_id in leaf_ids
    ]
    lengths: List[NodeLengthOut] = [
        NodeLengthOut(node_id=node_id, length=float(x[index.length_col[node_id]])) for node_id in length_ids
    ]
    return SnapPathsResponse(status="ok", leaf_positions=leaf_positions, lengths=lengths, snapped_count=len(active_paths))
