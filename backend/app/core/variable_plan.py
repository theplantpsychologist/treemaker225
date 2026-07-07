from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np

from app.schemas.constraints import Constraints, SymmetryMode


def reflect_across_symmetry(pos: Tuple[float, float], mode: SymmetryMode) -> Tuple[float, float]:
    x, y = pos
    if mode == SymmetryMode.BOOK:
        return (1.0 - x, y)
    if mode == SymmetryMode.DIAGONAL:
        return (y, x)
    raise ValueError(f"cannot reflect a pair without a symmetry mode (got {mode})")


def edge_position(edge: str, s: float) -> Tuple[float, float]:
    if edge == "left":
        return (0.0, s)
    if edge == "right":
        return (1.0, s)
    if edge == "top":
        return (s, 0.0)
    if edge == "bottom":
        return (s, 1.0)
    raise ValueError(f"unknown edge {edge}")


def corner_position(corner: str) -> Tuple[float, float]:
    return {
        "top_left": (0.0, 0.0),
        "top_right": (1.0, 0.0),
        "bottom_left": (0.0, 1.0),
        "bottom_right": (1.0, 1.0),
    }[corner]


@dataclass
class LeafVarSpec:
    kind: str
    var_start: int
    n_vars: int
    edge: Optional[str] = None
    corner: Optional[str] = None
    paired_with: Optional[str] = None


class VariablePlan:
    """Maps each leaf to its reduced set of free solver variables given the
    active constraints, and decodes a full solver vector back into every
    leaf's (x, y) position + the global scale."""

    def __init__(self, leaf_ids: List[str], constraints: Constraints):
        self.leaf_ids = leaf_ids
        self.symmetry_mode = constraints.symmetry_mode
        self.specs: Dict[str, LeafVarSpec] = {}

        idx = 0
        for leaf_id in leaf_ids:
            c = constraints.per_leaf.get(leaf_id)
            kind = c.kind if c else "none"
            if kind == "pin_symmetry":
                self.specs[leaf_id] = LeafVarSpec("symmetry_free", idx, 1)
                idx += 1
            elif kind == "pair":
                partner = c.paired_with
                if leaf_id < partner:
                    self.specs[leaf_id] = LeafVarSpec("pair_primary", idx, 2, paired_with=partner)
                    idx += 2
                else:
                    self.specs[leaf_id] = LeafVarSpec("pair_secondary", 0, 0, paired_with=partner)
            elif kind == "pin_edge":
                self.specs[leaf_id] = LeafVarSpec("edge_free", idx, 1, edge=c.edge)
                idx += 1
            elif kind == "pin_corner":
                self.specs[leaf_id] = LeafVarSpec("corner_fixed", 0, 0, corner=c.corner)
            else:
                self.specs[leaf_id] = LeafVarSpec("free", idx, 2)
                idx += 2

        self.n_position_vars = idx
        self.total_dim = idx + 1

    def bounds(self) -> List[Tuple[Optional[float], Optional[float]]]:
        b: List[Tuple[Optional[float], Optional[float]]] = []
        for leaf_id in self.leaf_ids:
            b += [(0.0, 1.0)] * self.specs[leaf_id].n_vars
        b.append((1e-9, None))
        return b

    def decode(self, x: np.ndarray) -> Tuple[Dict[str, Tuple[float, float]], float]:
        scale = float(x[-1])
        positions: Dict[str, Tuple[float, float]] = {}
        for leaf_id in self.leaf_ids:
            spec = self.specs[leaf_id]
            if spec.kind in ("free", "pair_primary"):
                positions[leaf_id] = (float(x[spec.var_start]), float(x[spec.var_start + 1]))
            elif spec.kind == "symmetry_free":
                t = float(x[spec.var_start])
                positions[leaf_id] = (0.5, t) if self.symmetry_mode == SymmetryMode.BOOK else (t, t)
            elif spec.kind == "edge_free":
                positions[leaf_id] = edge_position(spec.edge, float(x[spec.var_start]))
            elif spec.kind == "corner_fixed":
                positions[leaf_id] = corner_position(spec.corner)
        for leaf_id in self.leaf_ids:
            spec = self.specs[leaf_id]
            if spec.kind == "pair_secondary":
                positions[leaf_id] = reflect_across_symmetry(positions[spec.paired_with], self.symmetry_mode)
        return positions, scale

    def random_initial_guess(self, rng, scale_guess: float) -> np.ndarray:
        x = [0.0] * self.n_position_vars
        for leaf_id in self.leaf_ids:
            spec = self.specs[leaf_id]
            for k in range(spec.n_vars):
                x[spec.var_start + k] = rng.random()
        x.append(scale_guess)
        return np.array(x)

    def encode_from_positions(self, positions: Dict[str, Tuple[float, float]], scale: float) -> np.ndarray:
        x = [0.0] * self.n_position_vars
        for leaf_id in self.leaf_ids:
            spec = self.specs[leaf_id]
            px, py = positions[leaf_id]
            if spec.kind in ("free", "pair_primary"):
                x[spec.var_start] = px
                x[spec.var_start + 1] = py
            elif spec.kind == "symmetry_free":
                x[spec.var_start] = py if self.symmetry_mode == SymmetryMode.BOOK else (px + py) / 2
            elif spec.kind == "edge_free":
                x[spec.var_start] = py if spec.edge in ("left", "right") else px
        x.append(scale)
        return np.array(x)
