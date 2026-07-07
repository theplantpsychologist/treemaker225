from typing import Literal, Optional

from app.schemas.common import CamelModel

ShapeKind = Literal["circle", "square", "hexagon", "octagon", "dodecagon"]


class Hyperparams(CamelModel):
    n_restarts: int = 100
    n_refine: int = 10
    alpha: float = 100.0
    shape: ShapeKind = "octagon"
    seed: Optional[int] = None
