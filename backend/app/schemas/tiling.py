from typing import List, Literal, Optional

from app.schemas.common import CamelModel
from app.schemas.constraints import Constraints
from app.schemas.hyperparams import Hyperparams
from app.schemas.solve import NodePositionOut
from app.schemas.tree import TreeIn


class TilingRequest(CamelModel):
    tree: TreeIn
    constraints: Constraints = Constraints()
    hyperparams: Hyperparams = Hyperparams()
    positions: List[NodePositionOut]
    scale: float


class SelectedTilingPathOut(CamelModel):
    a: str
    b: str


class TilingVertexLegOut(CamelModel):
    flap: str
    angle: float


class TilingVertexOut(CamelModel):
    """A junction where 2 (free bend) or 3+ (real concurrency-constrained)
    legs meet -- covers both kinds uniformly so the frontend can draw leg
    lines + a vertex dot without a case split."""

    id: str
    x: float
    y: float
    legs: List[TilingVertexLegOut]


class TilingResponse(CamelModel):
    status: Literal["ok", "error"]
    message: Optional[str] = None
    leaf_positions: List[NodePositionOut] = []
    internal_positions: List[NodePositionOut] = []
    selected_direct_paths: List[SelectedTilingPathOut] = []
    vertices: List[TilingVertexOut] = []
