/**
 * Pixel-based sizes that must stay a constant number of screen pixels
 * regardless of the current pan/zoom level. Unlike stroke width (handled for
 * free by `vector-effect: non-scaling-stroke` in `styles/tokens.css`), radii
 * and hit-test tolerances have no CSS equivalent — components convert these
 * to world-space units at render time via `useViewBoxPanZoom`'s `pxToWorld`.
 */
export const TREE_NODE_RADIUS_PX = 7
export const CENTER_DOT_RADIUS_PX = 3
export const EDGE_PIN_HANDLE_THICKNESS_PX = 16
export const CORNER_PIN_HANDLE_SIZE_PX = 14
export const EDGE_HIT_TOLERANCE_MIN_PX = 6
