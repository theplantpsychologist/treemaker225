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


class FlapConstraint(CamelModel):
    kind: Literal["none", "pin_symmetry", "pair", "pin_edge", "pin_corner"] = "none"
    paired_with: Optional[str] = None
    edge: Optional[EdgeSide] = None
    corner: Optional[CornerId] = None


class Constraints(CamelModel):
    symmetry_mode: SymmetryMode = SymmetryMode.NONE
    per_leaf: Dict[str, FlapConstraint] = {}
