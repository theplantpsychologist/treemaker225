from enum import Enum
from typing import Dict, Literal, Optional

from app.schemas.common import CamelModel


class SymmetryMode(str, Enum):
    NONE = "none"
    BOOK = "book"
    DIAGONAL = "diagonal"


class EdgeSide(str, Enum):
    TOP = "top"
    BOTTOM = "bottom"
    LEFT = "left"
    RIGHT = "right"


class CornerId(str, Enum):
    TOP_LEFT = "top_left"
    TOP_RIGHT = "top_right"
    BOTTOM_LEFT = "bottom_left"
    BOTTOM_RIGHT = "bottom_right"


class SymmetryConstraint(CamelModel):
    """Whether/how a leaf relates to the global symmetry line — independent
    of its boundary constraint (see `LeafConstraint`)."""

    kind: Literal["none", "pin_symmetry", "pair"] = "none"
    paired_with: Optional[str] = None


class BoundaryConstraint(CamelModel):
    """Whether/how a leaf is pinned to the paper's edge/corner —
    independent of its symmetry constraint (see `LeafConstraint`)."""

    kind: Literal["none", "pin_edge", "pin_corner"] = "none"
    edge: Optional[EdgeSide] = None
    corner: Optional[CornerId] = None


class LockPoint(CamelModel):
    x: float
    y: float


class LockConstraint(CamelModel):
    """A third, orthogonal slot: freezes whatever positional degrees of
    freedom the symmetry+boundary combo leaves free at a snapshot value —
    independent of both other slots (see `LeafConstraint`)."""

    kind: Literal["none", "locked"] = "none"
    point: Optional[LockPoint] = None


class LeafConstraint(CamelModel):
    symmetry: SymmetryConstraint = SymmetryConstraint()
    boundary: BoundaryConstraint = BoundaryConstraint()
    locked: LockConstraint = LockConstraint()


class Constraints(CamelModel):
    symmetry_mode: SymmetryMode = SymmetryMode.NONE
    per_leaf: Dict[str, LeafConstraint] = {}
