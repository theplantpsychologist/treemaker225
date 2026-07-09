import type { ShapeKind } from '../geometry/shapes'

export interface ShapeThemeEntry {
  accent: string
  flap: string
  river: string
  /** Color of the packing canvas's "active path" lines (see
   * `geometry/activePaths.ts`) for this shape — defaults to the same value
   * as `accent` below, but kept as its own field so it can be tuned
   * independently per shape without another mechanism. */
  activePath: string
}

/** One accent + flap + river + active-path color per packing shape — the
 * single place to tune the whole app's color scheme. `accent` drives
 * buttons/sliders/highlights/tree-node colors; `flap`/`river`/`activePath`
 * are the packing canvas's own colors (see `PackingEditor.css`'s
 * `.packing-flap`/`.packing-river`/`.active-path`). Selected state, overlap
 * highlights, and delete buttons stay hardcoded red always (see
 * `constraintColors.ts`), never themed. */
export const SHAPE_THEME: Record<ShapeKind, ShapeThemeEntry> = {
  circle: { accent: '#db2777', flap: '#db2777', river: '#f472b6', activePath: '#db2777' },
  square: { accent: '#2563eb', flap: '#2563eb', river: '#60a5fa', activePath: '#2563eb' },
  hexagon: { accent: '#ca8a04', flap: '#ca8a04', river: '#facc15', activePath: '#ca8a04' },
  octagon: { accent: '#16a34a', flap: '#16a34a', river: '#4ade80', activePath: '#16a34a' },
  dodecagon: { accent: '#ea580c', flap: '#ea580c', river: '#fb923c', activePath: '#ea580c' },
}
