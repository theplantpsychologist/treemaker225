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
    # Dodecagon-only: rotates it 15 degrees. A manual toggle, mirrors
    # square_extra_rotation's mechanism -- any diagonal-symmetry default
    # lives at the frontend store's call site.
    dodecagon_extra_rotation: bool = False
    seed: Optional[int] = None
    solver_method: SolverMethod = "slsqp"
    # Left unset (None) to use scipy's own per-method defaults.
    tol: Optional[float] = None
    max_iter: Optional[int] = None
    # Mirrors the frontend's rendering tolerances (see
    # frontend/src/types/hyperparams.ts) -- needed here too so
    # app/core/active_paths.py recomputes exactly the same active/semi-active
    # split the user currently sees before snapping it.
    active_snap_length_tolerance: float = 0.1
    active_snap_angle_tolerance: float = 10.0
    # Only meaningful with initFrom=CURRENT (a re-optimize, not the first
    # solve): the largest per-restart random displacement applied to
    # position variables, ramping linearly from 0 (restart 0, the exact
    # current layout) up to this by the last restart -- see
    # solve_service.py's basin-hopping-style restart loop. Perturbation is
    # deliberately allowed to push a position outside [0,1].
    max_noise_amplitude: float = 0.2
