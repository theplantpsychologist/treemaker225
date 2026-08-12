from typing import List, Literal, Optional

from app.schemas.common import CamelModel
from app.schemas.constraints import Constraints
from app.schemas.hyperparams import Hyperparams
from app.schemas.snap import NodeLengthOut
from app.schemas.solve import NodePositionOut
from app.schemas.tree import TreeIn


class PathNetworkRequest(CamelModel):
    tree: TreeIn
    constraints: Constraints = Constraints()
    hyperparams: Hyperparams = Hyperparams()
    positions: List[NodePositionOut]
    scale: float


class SelectedDirectPathOut(CamelModel):
    a: str
    b: str


class SelectedLegOut(CamelModel):
    """One selected half-leg, for the tiling canvas's view-only rendering --
    a straight segment from `flap`'s position to (x, y). Legs sharing the
    same `point_id` terminate at the identical intermediate point."""

    flap: str
    point_id: str
    x: float
    y: float


class PathNetworkResponse(CamelModel):
    status: Literal["ok", "error"]
    message: Optional[str] = None
    leaf_positions: List[NodePositionOut] = []
    lengths: List[NodeLengthOut] = []
    selected_direct_paths: List[SelectedDirectPathOut] = []
    selected_legs: List[SelectedLegOut] = []
