import math
from typing import Dict, Optional, Tuple

ShapeBases = Tuple[Tuple[float, float], ...]


def regular_ngon_bases(n: int, angle_offset: float = 0.0) -> ShapeBases:
    """Unit face-normal directions of a regular n-gon, evenly spaced starting
    at angle_offset (radians)."""
    return tuple(
        (math.cos(angle_offset + 2 * math.pi * k / n), math.sin(angle_offset + 2 * math.pi * k / n))
        for k in range(n)
    )


# Preserved as the exact geometry the original octagon-only implementation used.
OCT_BASES: ShapeBases = regular_ngon_bases(8)

SHAPE_BASES: Dict[str, ShapeBases] = {
    "square": regular_ngon_bases(4),
    # A horizontal top/bottom edge means a vertical face normal, hence the 90-degree offset.
    "hexagon": regular_ngon_bases(6, angle_offset=math.pi / 2),
    "octagon": OCT_BASES,
    "dodecagon": regular_ngon_bases(12),
}


def get_bases(shape: str) -> Optional[ShapeBases]:
    """The separating-axis bases for `shape`, or None for 'circle' — the
    degenerate case with no discrete bases, handled via exact Euclidean
    distance instead (the alpha -> infinity, infinite-basis limit)."""
    if shape == "circle":
        return None
    return SHAPE_BASES[shape]
