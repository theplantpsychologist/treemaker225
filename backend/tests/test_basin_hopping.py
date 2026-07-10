import random

import numpy as np

from app.core.packing import run_circle_restart
from app.core.tree import build_tree
from app.core.variable_plan import VariablePlan
from app.schemas.constraints import Constraints
from app.schemas.hyperparams import Hyperparams
from app.schemas.tree import NodeIn, TreeIn
from app.services.solve_service import _perturb_position_vars, _seeded_restarts


def _star_tree():
    return build_tree(
        TreeIn(
            root_id="root",
            nodes=[
                NodeIn(id="root", parent_id=None, length=None),
                NodeIn(id="leaf_a", parent_id="root", length=3),
                NodeIn(id="leaf_b", parent_id="root", length=5),
                NodeIn(id="leaf_c", parent_id="root", length=4),
            ],
        )
    )


def test_perturb_position_vars_is_not_clamped_to_unit_square():
    x0 = np.array([0.05, 0.05, 0.5, 0.5])
    rng = random.Random(0)
    # A large, fixed noise combined with a low-x0 start should be able to
    # push a coordinate below 0 -- if this were still clamped, the result
    # would never go negative no matter how many draws we take.
    found_negative = False
    for _ in range(50):
        x = _perturb_position_vars(x0, 4, rng, noise=1.0)
        if np.any(x < 0) or np.any(x > 1):
            found_negative = True
            break
    assert found_negative


def test_seeded_restarts_restart_zero_matches_unperturbed_seed():
    tree = _star_tree()
    leaf_ids = ["leaf_a", "leaf_b", "leaf_c"]
    plan = VariablePlan(leaf_ids, Constraints())
    base_x0 = plan.encode_from_positions({"leaf_a": (0.1, 0.1), "leaf_b": (0.9, 0.1), "leaf_c": (0.5, 0.9)}, 0.01)
    hp = Hyperparams(n_restarts=5, seed=42, max_noise_amplitude=0.2)
    solver_args = (hp.solver_method, hp.tol, hp.max_iter)

    results = _seeded_restarts(plan, tree, base_x0, hp, solver_args)
    assert len(results) == hp.n_restarts

    expected_x, expected_scale, expected_success = run_circle_restart(plan, tree, base_x0, *solver_args)
    actual_x, actual_scale, actual_success = results[0]
    assert np.allclose(actual_x, expected_x)
    assert actual_scale == expected_scale
    assert actual_success == expected_success


def test_seeded_restarts_never_worse_than_unperturbed_seed_alone():
    tree = _star_tree()
    leaf_ids = ["leaf_a", "leaf_b", "leaf_c"]
    plan = VariablePlan(leaf_ids, Constraints())
    base_x0 = plan.encode_from_positions({"leaf_a": (0.1, 0.1), "leaf_b": (0.9, 0.1), "leaf_c": (0.5, 0.9)}, 0.01)
    hp = Hyperparams(n_restarts=8, seed=7, max_noise_amplitude=0.3)
    solver_args = (hp.solver_method, hp.tol, hp.max_iter)

    _, seed_scale, seed_success = run_circle_restart(plan, tree, base_x0, *solver_args)
    results = _seeded_restarts(plan, tree, base_x0, hp, solver_args)
    best = max(results, key=lambda r: (r[2], r[1]))
    assert (best[2], best[1]) >= (seed_success, seed_scale)
