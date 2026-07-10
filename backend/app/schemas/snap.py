from typing import List, Literal, Optional

from app.schemas.common import CamelModel
from app.schemas.constraints import Constraints
from app.schemas.hyperparams import Hyperparams
from app.schemas.solve import NodePositionOut
from app.schemas.tree import TreeIn


class NodeLengthOut(CamelModel):
    node_id: str
    length: float


class SnapPathsRequest(CamelModel):
    tree: TreeIn
    constraints: Constraints = Constraints()
    hyperparams: Hyperparams = Hyperparams()
    # Every current leaf + internal node position (only leaf positions are
    # variables in the snap solve, but internal ids are harmless extras --
    # the service just ignores anything outside leaf_ids).
    positions: List[NodePositionOut]
    scale: float


class SnapPathsResponse(CamelModel):
    status: Literal["ok", "error"]
    message: Optional[str] = None
    leaf_positions: List[NodePositionOut] = []
    lengths: List[NodeLengthOut] = []
    # How many active (solid-line) paths were found and snapped -- 0 means
    # "nothing to do," surfaced by the frontend as a soft no-op message
    # rather than an error.
    snapped_count: int = 0
