from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np

from app.core.constraint_resolution import (
    corner_position,
    edge_position,
    reflect_across_symmetry,
    resolve_leaf_constraint,
)
from app.schemas.constraints import Constraints, LeafConstraint, SymmetryMode


@dataclass
class LeafVarSpec:
    kind: str
    var_start: int
    n_vars: int
    edge: Optional[str] = None
    fixed_point: Optional[Tuple[float, float]] = None
    paired_with: Optional[str] = None


def _own_spec(leaf_id: str, constraint: LeafConstraint, mode: SymmetryMode, var_start: int) -> LeafVarSpec:
    """A leaf's degrees of freedom from its OWN symmetry+boundary combo,
    ignoring pairing (a pair leader still resolves via this — `pin_symmetry`
    and `pair` are mutually exclusive values of the same slot, so a pair
    member's own resolution only ever depends on its boundary slot)."""
    boundary = constraint.boundary
    if boundary.kind == "pin_corner":
        return LeafVarSpec("corner_fixed", var_start, 0, fixed_point=corner_position(boundary.corner))
    if boundary.kind == "pin_edge":
        if constraint.symmetry.kind == "pin_symmetry":
            point = resolve_leaf_constraint(mode, constraint).point
            return LeafVarSpec("resolved_fixed", var_start, 0, fixed_point=point)
        return LeafVarSpec("edge_free", var_start, 1, edge=boundary.edge)
    if constraint.symmetry.kind == "pin_symmetry":
        return LeafVarSpec("symmetry_free", var_start, 1)
    return LeafVarSpec("free", var_start, 2)


class VariablePlan:
    """Maps each leaf to its reduced set of free solver variables given the
    active constraints, and decodes a full solver vector back into every
    leaf's (x, y) position + the global scale."""

    def __init__(self, leaf_ids: List[str], constraints: Constraints):
        self.leaf_ids = leaf_ids
        self.symmetry_mode = constraints.symmetry_mode
        self.specs: Dict[str, LeafVarSpec] = {}

        idx = 0
        pair_seen: set = set()
        for leaf_id in leaf_ids:
            if leaf_id in self.specs:
                continue
            c = constraints.per_leaf.get(leaf_id)
            constraint = c if c is not None else LeafConstraint()

            if constraint.symmetry.kind == "pair" and leaf_id not in pair_seen:
                partner = constraint.symmetry.paired_with
                partner_c = constraints.per_leaf.get(partner) or LeafConstraint()
                pair_seen.add(leaf_id)
                pair_seen.add(partner)
                # Whichever side actually carries a boundary pin (if either)
                # must be the leader — validation upstream guarantees at
                # most one side does. With neither pinned, fall back to a
                # stable lexicographic tie-break.
                if constraint.boundary.kind != "none":
                    leader_id, follower_id = leaf_id, partner
                elif partner_c.boundary.kind != "none":
                    leader_id, follower_id = partner, leaf_id
                else:
                    leader_id, follower_id = (leaf_id, partner) if leaf_id < partner else (partner, leaf_id)

                leader_constraint = constraint if leader_id == leaf_id else partner_c
                leader_spec = _own_spec(leader_id, leader_constraint, self.symmetry_mode, idx)
                self.specs[leader_id] = leader_spec
                idx += leader_spec.n_vars
                self.specs[follower_id] = LeafVarSpec("pair_secondary", 0, 0, paired_with=leader_id)
                continue

            spec = _own_spec(leaf_id, constraint, self.symmetry_mode, idx)
            self.specs[leaf_id] = spec
            idx += spec.n_vars

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
            if spec.kind == "free":
                positions[leaf_id] = (float(x[spec.var_start]), float(x[spec.var_start + 1]))
            elif spec.kind == "symmetry_free":
                t = float(x[spec.var_start])
                positions[leaf_id] = (0.5, t) if self.symmetry_mode == SymmetryMode.BOOK else (t, t)
            elif spec.kind == "edge_free":
                positions[leaf_id] = edge_position(spec.edge, float(x[spec.var_start]))
            elif spec.kind in ("corner_fixed", "resolved_fixed"):
                positions[leaf_id] = spec.fixed_point
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
            if spec.kind == "free":
                x[spec.var_start] = px
                x[spec.var_start + 1] = py
            elif spec.kind == "symmetry_free":
                x[spec.var_start] = py if self.symmetry_mode == SymmetryMode.BOOK else (px + py) / 2
            elif spec.kind == "edge_free":
                x[spec.var_start] = py if spec.edge in ("left", "right") else px
        x.append(scale)
        return np.array(x)
