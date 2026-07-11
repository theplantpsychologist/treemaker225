"""Cumulative Wave Kernel Signature (CWKS) matching, with an analytical
gradient of the CWKS-MSE with respect to every tree edge length.

Mirrors prototypes/tree.py's extract_eigenvalues + prototypes/faiss_cache.py's
compute_wks_signature, with one deliberate deviation: the mesh resampling
(how many subdivision segments each edge gets) is frozen once, from the
lengths at solve-start, instead of being recomputed from `ceil(l_e / target)`
on every call. Recomputing it live would make the mesh topology -- and hence
the eigenproblem's dimension -- a step function of the lengths, which has no
gradient at all. Freezing it keeps every downstream quantity a smooth
(in fact rational) function of the current lengths, which is what makes an
analytical gradient possible instead of finite differences (which would cost
one extra eigendecomposition per length variable per solver iteration).

Gradient derivation (generalized eigenvalue sensitivity): for the generalized
problem L(l) v_k = lambda_k(l) M(l) v_k with v_k M-normalized
(v_k^T M v_k = 1), the standard first-order sensitivity result (Fox & Kapoor,
"Rates of Change of Eigenvalues and Eigenvectors", AIAA Journal, 1968 -- the
textbook reference for gradient-based frequency/spectral optimization) is:

    d(lambda_k)/d(l_f) = v_k^T (dL/d(l_f) - lambda_k * dM/d(l_f)) v_k

L and M are sums of per-segment rank-1 contributions, each segment's
normalized length L_hat = l_e / (m_e * S) where S = sum of ALL edge lengths --
so changing any one edge's length perturbs every segment's normalized length
a little via S, not just its own. That couples every edge's gradient
contribution through two pieces: a "local" term (only segments belonging to
edge f) and a single "global" correction (identical for every f, from the
1/S coupling) computed once per eigenvector -- see `_length_gradient` for the
closed form. This keeps the whole gradient O(K * n_mesh) per solver
iteration (K = number of retained eigenvalues), independent of the number of
length variables, which is the whole point of computing it analytically
rather than by finite differences.

Known caveat shared with the rest of the spectral-optimization literature:
this formula assumes simple (non-repeated) eigenvalues -- at an eigenvalue
crossing the true objective has a non-smooth kink. SLSQP just sees an
occasional bad step there; the existing basin-hopping restart wrapper already
tolerates that.
"""

import math
from dataclasses import dataclass
from typing import Dict, List, Tuple

import networkx as nx
import numpy as np
from scipy.linalg import eigh

EIG_COUNT = 32
RESOLUTION = 0.02

DIMENSION = 64
E_MIN = 3.0
E_MAX = 10.0


@dataclass
class SpectralMesh:
    """Frozen resampling topology for a tree's edge set. Every quantity here
    depends only on the INITIAL lengths (via `build_mesh`'s `m_e` per edge)
    -- everything length-dependent afterwards is computed fresh from the
    current lengths by `_segment_quantities`/`assemble`, so re-solving with a
    different trial length vector never touches this struct again."""

    edge_ids: List[str]
    n_mesh_nodes: int
    seg_i: np.ndarray
    seg_j: np.ndarray
    seg_edge_idx: np.ndarray
    seg_m: np.ndarray


def build_mesh(
    tree: nx.DiGraph,
    edge_ids: List[str],
    initial_lengths: Dict[str, float],
    resolution: float = RESOLUTION,
) -> SpectralMesh:
    total0 = sum(initial_lengths[e] for e in edge_ids)
    target = resolution * total0 if total0 > 0 else 1.0

    node_index: Dict[str, int] = {}
    for node in tree.nodes:
        node_index[node] = len(node_index)
    counter = len(node_index)

    seg_i: List[int] = []
    seg_j: List[int] = []
    seg_edge_idx: List[int] = []
    seg_m: List[float] = []

    for f, edge_id in enumerate(edge_ids):
        parent = next(tree.predecessors(edge_id))
        l0 = initial_lengths[edge_id]
        m = max(1, math.ceil(l0 / target)) if l0 > 0 else 1

        prev = node_index[parent]
        for _ in range(m - 1):
            mid = counter
            counter += 1
            seg_i.append(prev)
            seg_j.append(mid)
            seg_edge_idx.append(f)
            seg_m.append(float(m))
            prev = mid
        seg_i.append(prev)
        seg_j.append(node_index[edge_id])
        seg_edge_idx.append(f)
        seg_m.append(float(m))

    return SpectralMesh(
        edge_ids=list(edge_ids),
        n_mesh_nodes=counter,
        seg_i=np.array(seg_i, dtype=np.int64),
        seg_j=np.array(seg_j, dtype=np.int64),
        seg_edge_idx=np.array(seg_edge_idx, dtype=np.int64),
        seg_m=np.array(seg_m, dtype=np.float64),
    )


def _lengths_array(mesh: SpectralMesh, lengths: Dict[str, float]) -> np.ndarray:
    return np.array([lengths[e] for e in mesh.edge_ids], dtype=np.float64)


def _segment_quantities(mesh: SpectralMesh, lengths_arr: np.ndarray):
    """L_hat (normalized segment length) and conductance c=1/L_hat per
    segment, plus the current total length S -- every length-dependent
    quantity the rest of this module needs, recomputed fresh each call."""
    s = float(lengths_arr.sum())
    l_e = lengths_arr[mesh.seg_edge_idx]
    l_hat = l_e / (mesh.seg_m * s)
    c = 1.0 / np.maximum(l_hat, 1e-7)
    return s, l_hat, c


def assemble(mesh: SpectralMesh, lengths_arr: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Builds the (dense) Laplacian and lumped mass matrix for the current
    lengths, over the frozen mesh topology."""
    s, l_hat, c = _segment_quantities(mesh, lengths_arr)
    n = mesh.n_mesh_nodes
    lap = np.zeros((n, n))
    mass = np.zeros((n, n))
    i, j = mesh.seg_i, mesh.seg_j
    np.add.at(lap, (i, i), c)
    np.add.at(lap, (j, j), c)
    np.add.at(lap, (i, j), -c)
    np.add.at(lap, (j, i), -c)
    seg_mass = l_hat / 2.0
    np.add.at(mass, (i, i), seg_mass)
    np.add.at(mass, (j, j), seg_mass)
    return lap, mass


def eigen_decompose(
    mesh: SpectralMesh, lengths_arr: np.ndarray, eig_count: int = EIG_COUNT
) -> Tuple[np.ndarray, np.ndarray]:
    """Returns (eigenvalues, eigenvectors) -- eig_count of them (zero-padded
    if the mesh is too small), dropping the near-zero trivial mode, sorted
    ascending. Eigenvectors are columns, defensively re-normalized to be
    exactly M-orthonormal (v_k^T M v_k = 1) regardless of the LAPACK driver's
    own convention -- required for `_length_gradient`'s sensitivity formula.
    """
    lap, mass = assemble(mesh, lengths_arr)
    eigvals, eigvecs = eigh(lap, mass)
    eigvals = np.clip(eigvals, 0, None)
    order = np.argsort(eigvals)
    eigvals = eigvals[order][1:]
    eigvecs = eigvecs[:, order][:, 1:]

    if eigvals.shape[0] > 0:
        # LAPACK's generalized symmetric solver already returns
        # M-orthonormal columns -- this just defends against a different
        # driver/version ever not guaranteeing that. The matmul below
        # occasionally trips a spurious divide-by-zero FPE flag on some
        # BLAS builds even though every operand and the result are finite
        # (confirmed via np.isfinite) -- harmless, so it's suppressed here.
        with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
            mv = mass @ eigvecs
        norms = np.einsum("ik,ik->k", eigvecs, mv)
        norms = np.maximum(norms, 1e-12)
        eigvecs = eigvecs / np.sqrt(norms)[None, :]

    k = min(eig_count, eigvals.shape[0])
    kept_vals = eigvals[:k]
    kept_vecs = eigvecs[:, :k]
    if k < eig_count:
        pad = eig_count - k
        kept_vals = np.concatenate([kept_vals, np.zeros(pad)])
        kept_vecs = np.concatenate([kept_vecs, np.zeros((mesh.n_mesh_nodes, pad))], axis=1)
    return kept_vals, kept_vecs


def cwks_signature(eigenvalues: np.ndarray, dim: int = DIMENSION, e_min: float = E_MIN, e_max: float = E_MAX) -> np.ndarray:
    """Single-sample port of prototypes/faiss_cache.py's compute_wks_signature."""
    e_sweep = np.linspace(e_min, e_max, dim)
    two_variance = 2.0 * (2 * (e_max - e_min) / (dim - 1)) ** 2
    mask = eigenvalues > 1e-6
    safe_eigs = np.where(mask, eigenvalues, 1.0)
    log_eigs = np.log(safe_eigs)
    diff = e_sweep[:, None] - log_eigs[None, :]
    band_pass = np.exp(-(diff**2) / two_variance)
    band_pass = np.where(mask[None, :], band_pass, 0.0)
    signature = band_pass.sum(axis=1)
    cumulative = np.cumsum(signature)
    last = cumulative[-1] if cumulative[-1] != 0 else 1.0
    return cumulative / last


def _length_gradient(
    mesh: SpectralMesh, lengths_arr: np.ndarray, eigvals: np.ndarray, eigvecs: np.ndarray
) -> np.ndarray:
    """d(lambda_k)/d(l_f) for every kept eigenvalue k and every edge f, shape
    (n_edges, K). See this module's docstring for the derivation."""
    s, l_hat, c = _segment_quantities(mesh, lengths_arr)
    n_edges = len(mesh.edge_ids)
    k_count = eigvals.shape[0]

    vi = eigvecs[mesh.seg_i, :]
    vj = eigvecs[mesh.seg_j, :]
    # NOT c * (vi-vj)**2 -- that would be the segment's actual contribution
    # to v^T L v, double-counting the conductance factor that dc_seg/d(l_f)
    # already accounts for below.
    q_l = (vi - vj) ** 2
    q_m = vi**2 + vj**2

    w_l = (c**2 / (mesh.seg_m * s))[:, None] * q_l
    local_l = np.zeros((n_edges, k_count))
    np.add.at(local_l, mesh.seg_edge_idx, w_l)
    local_l = -local_l

    w_m = (1.0 / (mesh.seg_m * s))[:, None] * q_m
    local_m = np.zeros((n_edges, k_count))
    np.add.at(local_m, mesh.seg_edge_idx, w_m)
    local_m = 0.5 * local_m

    g_l = (1.0 / s) * np.sum((c**2 * l_hat)[:, None] * q_l, axis=0)
    g_m = -(1.0 / (2 * s)) * np.sum(l_hat[:, None] * q_m, axis=0)

    return local_l - eigvals[None, :] * local_m + (g_l - eigvals * g_m)[None, :]


def cwks_mse_and_gradient(
    mesh: SpectralMesh,
    lengths: Dict[str, float],
    target_signature: np.ndarray,
    eig_count: int = EIG_COUNT,
    dim: int = DIMENSION,
    e_min: float = E_MIN,
    e_max: float = E_MAX,
) -> Tuple[float, Dict[str, float]]:
    """The CWKS-matching objective term and its exact gradient with respect
    to every edge length in `lengths`. Returns (mse, {edge_id: d(mse)/d(l)})."""
    lengths_arr = _lengths_array(mesh, lengths)
    eigvals, eigvecs = eigen_decompose(mesh, lengths_arr, eig_count)

    e_sweep = np.linspace(e_min, e_max, dim)
    two_variance = 2.0 * (2 * (e_max - e_min) / (dim - 1)) ** 2
    mask = eigvals > 1e-6
    safe_eigs = np.where(mask, eigvals, 1.0)
    log_eigs = np.log(safe_eigs)
    diff = e_sweep[:, None] - log_eigs[None, :]
    band_pass = np.exp(-(diff**2) / two_variance)
    band_pass = np.where(mask[None, :], band_pass, 0.0)
    signature = band_pass.sum(axis=1)
    cumulative = np.cumsum(signature)
    last = cumulative[-1] if cumulative[-1] != 0 else 1.0
    cdf = cumulative / last
    mse = float(np.mean((cdf - target_signature) ** 2))

    dlambda = _length_gradient(mesh, lengths_arr, eigvals, eigvecs)
    safe_eigvals = np.where(mask, eigvals, 1.0)
    dlog_eig = np.where(mask[None, :], dlambda / safe_eigvals[None, :], 0.0)

    dbandpass_dlogeig = band_pass * (2.0 / two_variance) * diff
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        d_signature = dbandpass_dlogeig @ dlog_eig.T
    d_cumulative = np.cumsum(d_signature, axis=0)

    if cumulative[-1] != 0:
        last_row = d_cumulative[-1, :]
        d_cdf = (d_cumulative * last - cumulative[:, None] * last_row[None, :]) / (last**2)
    else:
        d_cdf = d_cumulative

    d_mse = (2.0 / dim) * np.sum((cdf - target_signature)[:, None] * d_cdf, axis=0)

    return mse, {edge_id: float(d_mse[f]) for f, edge_id in enumerate(mesh.edge_ids)}
