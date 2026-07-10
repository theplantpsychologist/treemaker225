import math
from dataclasses import dataclass
from typing import Dict, List, Tuple

import networkx as nx

from app.core.shapes import get_bases
from app.core.tree import find_distance


@dataclass
class ActivePathEdge:
    """One leaf pair whose actual center distance is (near) the tree-implied
    tangency distance AND whose connecting angle is (near) one of the
    shape's face-normal directions -- i.e. a fully "active" (solid-line)
    path, exactly mirroring frontend/src/geometry/activePaths.ts's `kind ===
    'active'` case. Semi-active (dashed-parallelogram) pairs are dropped
    entirely here -- see the caller in `snap_active_paths`, this feature
    only ever snaps solid lines. `angle` is the target direction (radians)
    the path should be snapped to -- the nearest shape basis angle, already
    within tolerance of the pair's current angle."""

    a: str
    b: str
    angle: float


def compute_active_paths(
    tree: nx.DiGraph,
    leaf_ids: List[str],
    positions: Dict[str, Tuple[float, float]],
    scale: float,
    shape: str,
    symmetry_mode: str,
    extra_rotation: bool,
    length_tolerance: float,
    angle_tolerance_degrees: float,
) -> List[ActivePathEdge]:
    ids = [leaf_id for leaf_id in leaf_ids if leaf_id in positions]
    bases = get_bases(shape, symmetry_mode, extra_rotation)
    # Circle has no discrete face-normal directions to snap an angle to --
    # this feature has nothing to do for it (the caller also rejects circle/
    # square before ever reaching here; this is just a defensive fallback).
    if bases is None:
        return []
    angle_tolerance = math.radians(angle_tolerance_degrees)
    n = len(bases)
    period = 2 * math.pi / n
    offset_angle = math.atan2(bases[0][1], bases[0][0])

    results: List[ActivePathEdge] = []
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = ids[i], ids[j]
            pa, pb = positions[a], positions[b]
            dx, dy = pb[0] - pa[0], pb[1] - pa[1]
            dist = math.hypot(dx, dy)
            required = scale * find_distance(tree, a, b)
            if required <= 0:
                continue
            if abs(dist / required - 1) > length_tolerance:
                continue
            theta = math.atan2(dy, dx)
            k = round((theta - offset_angle) / period)
            nearest = offset_angle + k * period
            if abs(theta - nearest) > angle_tolerance:
                continue
            results.append(ActivePathEdge(a=a, b=b, angle=nearest))
    return results


def path_edge_ids(tree: nx.DiGraph, a: str, b: str) -> List[str]:
    """The child-node id of every parent/child edge along the tree path
    between two nodes -- each such id is exactly the variable identifying
    that edge's length (see path_snapping.py's VariableIndex)."""
    if a == b:
        return []
    undirected = tree.to_undirected(as_view=True)
    path = nx.shortest_path(undirected, a, b)
    edge_ids: List[str] = []
    for u, v in zip(path[:-1], path[1:]):
        edge_ids.append(v if tree.has_edge(u, v) else u)
    return edge_ids
