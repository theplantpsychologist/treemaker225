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

    # --- Path-network snap solver (see app/core/path_network*.py) ---
    # Weight on the primary objective: maximize the number of selected
    # direct paths plus the number of active (degree>=3) intermediate
    # points, each counted once. Deliberately large relative to C1/C2/C3 so
    # this signal dominates -- it's what actually drives the solver to
    # select anything at all now that there's no hard per-flap degree floor.
    path_network_count_weight: float = 1.0
    # Weight on the flap-displacement penalty: C1 * (initial normalized leaf
    # length)^2 * |displacement|^2, added to the objective.
    path_network_c1: float = 0.05
    # Weight on the length-change term: -C2 * (normalized length change) *
    # (initial normalized length) -- a reward when a length grows relative
    # to the whole tree, a penalty when it shrinks.
    path_network_c2: float = 0.01
    # Weight on the small per-active-intermediate-point penalty, biasing the
    # solve toward fewer/simpler indirect bends.
    path_network_c3: float = 0.001
    # How many outer continuation/annealing steps to run before giving up on
    # reaching a fully discrete (0/1) boolean relaxation.
    path_network_anneal_outer_iters: int = 6
    # Initial weight of the boolean-relaxation entropy penalty (see
    # path_network_vars.py's annealing term); grows by
    # path_network_anneal_weight_growth every outer iteration.
    path_network_anneal_weight_start: float = 1.0
    path_network_anneal_weight_growth: float = 3.0
    # Every relaxed boolean must land within this of 0 or 1 for the
    # continuation loop to stop early.
    path_network_bool_eps: float = 0.05
    # Basin-hopping restarts wrapping the whole anneal+round+polish pipeline
    # (see path_network_solve.py), mirroring max_noise_amplitude's role for
    # the main Optimize button.
    path_network_n_restarts: int = 8
    path_network_max_noise_amplitude: float = 0.15
    # Upper bound on any length variable, as a multiple of its initial
    # value -- the real fix for the runaway-length failure mode: without
    # this, a length whose every pair got pruned from the non-overlap check
    # had nothing at all stopping it from growing without limit.
    path_network_growth_cap: float = 3.0
    # Big-M slacks for the angle/length gated constraints at the START of
    # the anneal schedule (see path_network_solve.py) -- angle starts
    # tighter than length since an off-angle crease is a worse defect than
    # a slightly-off length.
    path_network_m_angle_start: float = 2.0
    path_network_m_length_start: float = 4.0
    # Both M's shrink by this factor every outer anneal iteration.
    path_network_m_decay: float = 0.5
    # ...down to no smaller than this floor.
    path_network_m_floor: float = 0.05
