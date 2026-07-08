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
    "octagon": OCT_BASES,
    "dodecagon": regular_ngon_bases(12),
}


def _square_bases(extra_rotation: bool) -> ShapeBases:
    """Square's angle offset is computed on demand, mirroring the hexagon
    pattern -- unlike hexagon's unconditional diagonal-symmetry rotation,
    square's 45-degree rotation is purely the manual extra_rotation toggle;
    any "default to rotated when diagonal symmetry is active" behavior lives
    at the frontend store's call site, not here."""
    offset = math.pi / 4 if extra_rotation else 0.0
    return regular_ngon_bases(4, offset)


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
    `symmetry_mode` only affects hexagon; `extra_rotation` is whichever
    shape's own rotation toggle is active for the current `shape` (callers
    compute this -- see `_hexagon_bases`/`_square_bases`)."""
    if shape == "circle":
        return None
    if shape == "hexagon":
        return _hexagon_bases(symmetry_mode, extra_rotation)
    if shape == "square":
        return _square_bases(extra_rotation)
    return SHAPE_BASES[shape]
