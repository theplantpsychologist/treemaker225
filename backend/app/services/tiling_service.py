from typing import Dict, Tuple

from app.core.layout import solve_internal_layout
from app.core.shapes import extra_rotation_for
from app.core.tiling_candidates import enumerate_tiling_candidates
from app.core.tiling_solve import solve_tiling
from app.core.tree import build_tree, get_leaves
from app.schemas.solve import NodePositionOut
from app.schemas.tiling import (
    SelectedTilingPathOut,
    TilingRequest,
    TilingResponse,
    TilingVertexLegOut,
    TilingVertexOut,
)

# Circle has no discrete face directions at all; square is excluded by the
# same long-standing convention as the other two path-snapping features
# (active_paths.py / path_snapping.py / path_network.py).
SNAPPABLE_SHAPES = {"hexagon", "octagon", "dodecagon"}


def solve_tiling_request(req: TilingRequest) -> TilingResponse:
    hp = req.hyperparams
    if hp.shape not in SNAPPABLE_SHAPES:
        raise ValueError(f"tiling solve requires one of {sorted(SNAPPABLE_SHAPES)}, got {hp.shape!r}")

    tree = build_tree(req.tree)
    leaf_ids = get_leaves(tree)

    positions: Dict[str, Tuple[float, float]] = {p.node_id: (p.x, p.y) for p in req.positions}
    missing = [leaf for leaf in leaf_ids if leaf not in positions]
    if missing:
        raise ValueError(f"missing positions for leaves: {missing}")

    extra_rotation = extra_rotation_for(
        hp.shape, hp.hexagon_extra_rotation, hp.square_extra_rotation, hp.dodecagon_extra_rotation
    )

    candidates = enumerate_tiling_candidates(
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
    if candidates is None:
        return TilingResponse(status="ok", message="tiling solve requires a shape with discrete face directions")

    result = solve_tiling(leaf_ids, positions, req.constraints, candidates, hp.tiling_strict_concavity)

    # Flap positions moved but tree lengths (hence radii/river widths) did
    # not -- internal (river) node positions need refitting to stay
    # consistent, exactly as /api/solve already does after its own pack.
    internal_positions = solve_internal_layout(tree, result.leaf_positions, req.scale)

    return TilingResponse(
        status="ok",
        message=None,
        leaf_positions=[NodePositionOut(node_id=n, x=p[0], y=p[1]) for n, p in result.leaf_positions.items()],
        internal_positions=[NodePositionOut(node_id=n, x=p[0], y=p[1]) for n, p in internal_positions.items()],
        selected_direct_paths=[SelectedTilingPathOut(a=d.a, b=d.b) for d in result.selected_direct_paths],
        vertices=[
            TilingVertexOut(id=v.id, x=v.x, y=v.y, legs=[TilingVertexLegOut(flap=f, angle=a) for f, a in v.legs])
            for v in result.vertices
        ],
    )
