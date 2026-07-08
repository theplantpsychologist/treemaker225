from typing import Literal, Optional

from app.schemas.common import CamelModel

ShapeKind = Literal["circle", "square", "hexagon", "octagon", "dodecagon"]

# L-BFGS-B is intentionally excluded -- see the comment at the top of
# app/core/packing.py for why it can't support this problem's constraints.
SolverMethod = Literal["slsqp", "cobyla", "trust-constr"]


class Hyperparams(CamelModel):
    n_restarts: int = 100
    n_refine: int = 10
    alpha: float = 100.0
    shape: ShapeKind = "octagon"
    # Hexagon-only: an extra 90-degree rotation on top of whatever the
    # symmetry mode already applies (see app/core/shapes.py's get_bases).
    hexagon_extra_rotation: bool = False
    # Square-only: rotates it 45 degrees into a diamond. A manual toggle,
    # not baked into get_bases -- any diagonal-symmetry default lives at the
    # frontend store's call site.
    square_extra_rotation: bool = False
    seed: Optional[int] = None
    solver_method: SolverMethod = "slsqp"
    # Left unset (None) to use scipy's own per-method defaults.
    tol: Optional[float] = None
    max_iter: Optional[int] = None
