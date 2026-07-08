from enum import Enum
from typing import List, Literal, Optional

from app.schemas.common import CamelModel
from app.schemas.constraints import Constraints
from app.schemas.hyperparams import Hyperparams
from app.schemas.tree import TreeIn


class InitFrom(str, Enum):
    RANDOM = "random"
    CURRENT = "current"


class NodePositionOut(CamelModel):
    node_id: str
    x: float
    y: float


class SolveRequest(CamelModel):
    tree: TreeIn
    constraints: Constraints = Constraints()
    hyperparams: Hyperparams = Hyperparams()
    init_from: InitFrom = InitFrom.RANDOM
    current_positions: Optional[List[NodePositionOut]] = None
    current_scale: Optional[float] = None
    # Only meaningful with init_from=CURRENT: run hp.n_restarts restarts,
    # each perturbing current_positions by an increasing noise amount
    # (restart 0 is always the exact, unperturbed seed), instead of a single
    # deterministic restart. Used for the very first real solve after the
    # frontend's naive pre-solve preview, so the solver isn't starting from
    # scratch but still explores multiple candidate solutions.
    seed_multi_restart: bool = False


class SolveDiagnostics(CamelModel):
    restarts_attempted: int
    best_scale_circle: float
    best_scale_refined: Optional[float] = None
    solve_time_ms: float


class SolveResponse(CamelModel):
    status: Literal["ok", "error"]
    message: Optional[str] = None
    scale: float
    leaf_positions: List[NodePositionOut]
    internal_positions: List[NodePositionOut] = []
    diagnostics: SolveDiagnostics
