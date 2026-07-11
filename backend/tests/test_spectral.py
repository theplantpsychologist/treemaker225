import numpy as np

from app.core.spectral import build_mesh, cwks_mse_and_gradient, cwks_signature, eigen_decompose
from app.core.tree import build_tree
from app.schemas.tree import NodeIn, TreeIn


def _star_tree():
    return build_tree(
        TreeIn(
            root_id="root",
            nodes=[
                NodeIn(id="root", parent_id=None, length=None),
                NodeIn(id="a", parent_id="root", length=3.0),
                NodeIn(id="b", parent_id="root", length=5.0),
                NodeIn(id="c", parent_id="root", length=4.0),
            ],
        )
    )


def _branching_tree():
    return build_tree(
        TreeIn(
            root_id="root",
            nodes=[
                NodeIn(id="root", parent_id=None, length=None),
                NodeIn(id="n1", parent_id="root", length=2.0),
                NodeIn(id="a", parent_id="n1", length=1.5),
                NodeIn(id="b", parent_id="n1", length=2.5),
                NodeIn(id="c", parent_id="root", length=3.0),
            ],
        )
    )


def _edge_ids(tree, root_id="root"):
    return [n for n in tree.nodes if n != root_id]


def test_cwks_signature_matches_itself_with_zero_mse():
    tree = _star_tree()
    edge_ids = _edge_ids(tree)
    lengths = {e: tree.edges[next(tree.predecessors(e)), e]["length"] for e in edge_ids}
    mesh = build_mesh(tree, edge_ids, lengths)
    eigvals, _ = eigen_decompose(mesh, np.array([lengths[e] for e in edge_ids]))
    target = cwks_signature(eigvals)

    mse, grad = cwks_mse_and_gradient(mesh, lengths, target)
    assert mse < 1e-9
    for e in edge_ids:
        assert abs(grad[e]) < 1e-6


def test_cwks_gradient_matches_finite_difference():
    tree = _branching_tree()
    edge_ids = _edge_ids(tree)
    initial_lengths = {e: tree.edges[next(tree.predecessors(e)), e]["length"] for e in edge_ids}
    mesh = build_mesh(tree, edge_ids, initial_lengths)

    # A deliberately different target (a *non-uniformly* perturbed tree's own
    # signature) so the MSE term -- and hence the gradient -- is nonzero and
    # non-trivial. A uniform rescale of every edge leaves the CWKS signature
    # unchanged (L_hat = l_e / total_length is scale-invariant by
    # construction), so the perturbation factors must differ per edge.
    factors = {"n1": 1.6, "a": 0.6, "b": 1.2, "c": 0.9}
    perturbed = {e: initial_lengths[e] * factors[e] for e in edge_ids}
    perturbed_eigs, _ = eigen_decompose(mesh, np.array([perturbed[e] for e in edge_ids]))
    target = cwks_signature(perturbed_eigs)

    trial_factors = {"n1": 0.85, "a": 1.4, "b": 0.7, "c": 1.1}
    trial = {e: initial_lengths[e] * trial_factors[e] for e in edge_ids}
    mse0, grad = cwks_mse_and_gradient(mesh, trial, target)

    eps = 1e-5
    for e in edge_ids:
        plus = dict(trial)
        plus[e] = trial[e] + eps
        minus = dict(trial)
        minus[e] = trial[e] - eps
        mse_plus, _ = cwks_mse_and_gradient(mesh, plus, target)
        mse_minus, _ = cwks_mse_and_gradient(mesh, minus, target)
        finite_diff = (mse_plus - mse_minus) / (2 * eps)
        assert abs(grad[e] - finite_diff) < 1e-4 * max(1.0, abs(finite_diff)), (
            f"edge {e}: analytical={grad[e]!r} finite_diff={finite_diff!r}"
        )
    assert mse0 > 1e-6
