from typing import Optional

from app.schemas.common import CamelModel


class Hyperparams(CamelModel):
    n_restarts: int = 100
    n_refine: int = 10
    alpha: float = 100.0
    run_octagon_refinement: bool = True
    seed: Optional[int] = None
