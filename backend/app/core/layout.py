from typing import Dict, List, Tuple

import networkx as nx
import numpy as np
from scipy.optimize import least_squares


def _descendant_leaves(tree: nx.DiGraph, node_id: str, leaf_positions: Dict[str, Tuple[float, float]]) -> List[str]:
    result: List[str] = []
    stack = [node_id]
    while stack:
        n = stack.pop()
        if n in leaf_positions:
            result.append(n)
        else:
            stack.extend(tree.successors(n))
    return result


def solve_internal_layout(
    tree: nx.DiGraph, leaf_positions: Dict[str, Tuple[float, float]], scale: float
) -> Dict[str, Tuple[float, float]]:
    """Fits every non-leaf node's (x, y) by minimizing, over every tree edge,
    the squared residual between the endpoints' Euclidean distance and
    scale * edge_length. Leaf positions are fixed from the main solve; this is
    what makes river-drawing possible even though internal nodes have no
    solver variables of their own in the main pack."""
    internal_ids = [n for n in tree.nodes if n not in leaf_positions]
    if not internal_ids:
        return {}

    index = {node_id: i for i, node_id in enumerate(internal_ids)}
    edges = list(tree.edges(data="length"))

    def get_pos(node_id: str, vec: np.ndarray) -> Tuple[float, float]:
        if node_id in leaf_positions:
            return leaf_positions[node_id]
        i = index[node_id]
        return (vec[2 * i], vec[2 * i + 1])

    def residuals(vec: np.ndarray) -> np.ndarray:
        out = []
        for u, v, length in edges:
            x1, y1 = get_pos(u, vec)
            x2, y2 = get_pos(v, vec)
            out.append(((x1 - x2) ** 2 + (y1 - y2) ** 2) ** 0.5 - scale * length)
        return np.array(out)

    x0 = np.zeros(2 * len(internal_ids))
    for node_id in internal_ids:
        leaves = _descendant_leaves(tree, node_id, leaf_positions) or list(leaf_positions.keys())
        cx = sum(leaf_positions[leaf][0] for leaf in leaves) / len(leaves)
        cy = sum(leaf_positions[leaf][1] for leaf in leaves) / len(leaves)
        i = index[node_id]
        x0[2 * i], x0[2 * i + 1] = cx, cy

    result = least_squares(residuals, x0)
    return {node_id: (float(result.x[2 * i]), float(result.x[2 * i + 1])) for node_id, i in index.items()}
