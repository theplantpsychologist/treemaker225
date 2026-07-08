from typing import Literal, Optional

from app.schemas.common import CamelModel

ShapeKind = Literal["circle", "square", "hexagon", "octagon", "dodecagon"]


class Hyperparams(CamelModel):
    n_restarts: int = 100
    n_refine: int = 10
    alpha: float = 100.0
    shape: ShapeKind = "octagon"
    # Hexagon-only: an extra 90-degree rotation on top of whatever the
    # symmetry mode already applies (see app/core/shapes.py's get_bases).
    hexagon_extra_rotation: bool = False
    seed: Optional[int] = None
