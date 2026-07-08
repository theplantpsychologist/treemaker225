import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject, PointerEvent as ReactPointerEvent } from 'react'

export interface ViewBox {
  x: number
  y: number
  w: number
  h: number
}

export interface WorldPoint {
  x: number
  y: number
}

const PAN_CLICK_THRESHOLD = 4
const ZOOM_MIN_FACTOR = 0.2
const ZOOM_MAX_FACTOR = 5

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

interface PanState {
  startClientX: number
  startClientY: number
  startViewBox: ViewBox
  dragging: boolean
}

/** Shared pan/zoom for an SVG canvas via a mutable viewBox. Existing
 * screen->world conversions (getScreenCTM().inverse()) automatically account
 * for whatever viewBox is current, so callers need no other changes. */
export function useViewBoxPanZoom(svgRef: RefObject<SVGSVGElement | null>, initial: ViewBox) {
  const [viewBox, setViewBox] = useState<ViewBox>(initial)
  const baseRef = useRef<ViewBox>(initial)
  const initializedRef = useRef(false)
  const panState = useRef<PanState | null>(null)
  const [renderedWidthPx, setRenderedWidthPx] = useState(0)

  const viewBoxAttr = `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`

  /** World (SVG viewBox) units per on-screen CSS pixel — multiply a desired
   * constant-screen-pixel size by this to get the equivalent world-space
   * size for the current pan/zoom level. Falls back to 1 before the SVG has
   * been measured. */
  const pxToWorld = renderedWidthPx > 0 ? viewBox.w / renderedWidthPx : 1

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) setRenderedWidthPx(width)
    })
    observer.observe(svg)
    return () => observer.disconnect()
  }, [svgRef])

  /** For canvases with no fixed logical coordinate space (the tree editor),
   * call once on mount with the SVG's actual rendered pixel box so world
   * units start out matching CSS pixels 1:1, as they did before pan/zoom. */
  const initializeBase = useCallback((w: number, h: number) => {
    if (initializedRef.current || w <= 0 || h <= 0) return
    initializedRef.current = true
    const vb = { x: 0, y: 0, w, h }
    baseRef.current = vb
    setViewBox(vb)
  }, [])

  const toWorldPoint = useCallback(
    (e: { clientX: number; clientY: number }): WorldPoint => {
      const svg = svgRef.current!
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const ctm = svg.getScreenCTM()!.inverse()
      const transformed = pt.matrixTransform(ctm)
      return { x: transformed.x, y: transformed.y }
    },
    [svgRef],
  )

  const beginPan = useCallback(
    (e: ReactPointerEvent) => {
      panState.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startViewBox: viewBox,
        dragging: false,
      }
    },
    [viewBox],
  )

  const onPanMove = useCallback(
    (e: ReactPointerEvent) => {
      const ps = panState.current
      const svg = svgRef.current
      if (!ps || !svg) return
      const dxClient = e.clientX - ps.startClientX
      const dyClient = e.clientY - ps.startClientY
      if (!ps.dragging) {
        if (Math.hypot(dxClient, dyClient) < PAN_CLICK_THRESHOLD) return
        ps.dragging = true
      }
      const rect = svg.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const scaleX = ps.startViewBox.w / rect.width
      const scaleY = ps.startViewBox.h / rect.height
      setViewBox({
        x: ps.startViewBox.x - dxClient * scaleX,
        y: ps.startViewBox.y - dyClient * scaleY,
        w: ps.startViewBox.w,
        h: ps.startViewBox.h,
      })
    },
    [svgRef],
  )

  /** Clears the pan gesture and reports what it was, so the caller can decide
   * whether a plain click (no drag) should fall through to its own
   * click semantics (deselect, add a node, etc). */
  const endPan = useCallback((): 'none' | 'click' | 'drag' => {
    const ps = panState.current
    panState.current = null
    if (!ps) return 'none'
    return ps.dragging ? 'drag' : 'click'
  }, [])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const world = pt.matrixTransform(ctm.inverse())
      setViewBox((vb) => {
        const factor = Math.exp(e.deltaY * 0.001)
        const base = baseRef.current
        const newW = clamp(vb.w * factor, base.w * ZOOM_MIN_FACTOR, base.w * ZOOM_MAX_FACTOR)
        const actualFactor = newW / vb.w
        const newH = vb.h * actualFactor
        return {
          x: world.x - (world.x - vb.x) * actualFactor,
          y: world.y - (world.y - vb.y) * actualFactor,
          w: newW,
          h: newH,
        }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [svgRef])

  return { viewBox, viewBoxAttr, beginPan, onPanMove, endPan, toWorldPoint, initializeBase, pxToWorld }
}
