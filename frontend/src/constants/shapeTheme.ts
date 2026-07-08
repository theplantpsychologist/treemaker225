import type { ShapeKind } from '../geometry/shapes'

export interface ShapeThemeEntry {
  accent: string
  flap: string
  river: string
}

/** One accent + flap + river color per packing shape — the single place to
 * tune the whole app's color scheme. `accent` drives buttons/sliders/
 * highlights/tree-node colors; `flap`/`river` are the packing canvas's only
 * two constraint-independent colors (see `PackingEditor.css`'s
 * `.packing-flap`/`.packing-river`). Selected state, overlap highlights,
 * and delete buttons stay hardcoded red always (see `constraintColors.ts`),
 * never themed. */
export const SHAPE_THEME: Record<ShapeKind, ShapeThemeEntry> = {
  circle: { accent: '#db2777', flap: '#db2777', river: '#f472b6' },
  square: { accent: '#2563eb', flap: '#2563eb', river: '#60a5fa' },
  hexagon: { accent: '#ca8a04', flap: '#ca8a04', river: '#facc15' },
  octagon: { accent: '#16a34a', flap: '#16a34a', river: '#4ade80' },
  dodecagon: { accent: '#ea580c', flap: '#ea580c', river: '#fb923c' },
}
