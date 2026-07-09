import { useEffect } from 'react'
import { SHAPE_THEME } from '../constants/shapeTheme'
import type { ShapeKind } from '../geometry/shapes'

/** Applies the active shape's theme as CSS custom properties on the
 * document root. Imperative `style.setProperty` (not the declarative
 * `style` prop) — this React/build combination silently drops custom-
 * property keys passed through the declarative style object (see
 * `components/icons/IconButton.tsx`'s established workaround). */
export function useShapeTheme(shape: ShapeKind): void {
  useEffect(() => {
    const theme = SHAPE_THEME[shape]
    const root = document.documentElement
    root.style.setProperty('--accent', theme.accent)
    root.style.setProperty('--flap-color', theme.flap)
    root.style.setProperty('--river-color', theme.river)
    root.style.setProperty('--active-path-color', theme.activePath)
  }, [shape])
}
