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
    "octagon": OCT_BASES,
    "dodecagon": regular_ngon_bases(12),
}


def _hexagon_bases(symmetry_mode: str, extra_rotation: bool) -> ShapeBases:
    """Hexagon's angle offset is computed on demand rather than read from a
    static table: diagonal symmetry rotates it 45 degrees so its vertices
    (not just its edges) line up with the mirror line, and the hexagon-only
    advanced setting adds another 90 degrees on top of that. A horizontal
    top/bottom edge in the base (unrotated) orientation means a vertical
    face normal, hence the base 90-degree offset."""
    offset = math.pi / 2
    if symmetry_mode == "diagonal":
        offset += math.pi / 4
    if extra_rotation:
        offset += math.pi / 2
    return regular_ngon_bases(6, offset)


def get_bases(shape: str, symmetry_mode: str = "none", extra_rotation: bool = False) -> Optional[ShapeBases]:
    """The separating-axis bases for `shape`, or None for 'circle' — the
    degenerate case with no discrete bases, handled via exact Euclidean
    distance instead (the alpha -> infinity, infinite-basis limit).
    `symmetry_mode`/`extra_rotation` only affect hexagon (see
    `_hexagon_bases`)."""
    if shape == "circle":
        return None
    if shape == "hexagon":
        return _hexagon_bases(symmetry_mode, extra_rotation)
    return SHAPE_BASES[shape]
