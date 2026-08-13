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

/** A square viewBox of `size x size` content, padded on all sides so the
 * content starts out smaller on screen (more zoomed out) than a 1:1
 * `{0, 0, size, size}` viewBox would show -- used as the *initial* viewBox
 * for canvases (packing, tiling) whose content already fills exactly
 * `size` world units, so the content stays centered rather than shifting
 * toward the origin corner. `factor > 1` zooms out; `1` is unpadded. */
export function paddedInitialViewBox(size: number, factor: number): ViewBox {
  const padded = size * factor
  const margin = (padded - size) / 2
  return { x: -margin, y: -margin, w: padded, h: padded }
}

const PAN_CLICK_THRESHOLD = 4
const ZOOM_MIN_FACTOR = 0.2
const ZOOM_MAX_FACTOR = 5

/** Default padding factor for `paddedInitialViewBox` -- shared by the
 * packing and tiling canvases so their initial zoom level (a bit more
 * zoomed out than a tight 1:1 fit) stays in sync. */
export const DEFAULT_INITIAL_ZOOM_OUT_FACTOR = 1.3

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
  /** True once the user has actually panned or zoomed -- read/written only
   * from plain event-handler code (never inside a `setState` updater; see
   * `initializeBase`'s doc for why that distinction matters), so it's a
   * safe, StrictMode-double-invocation-proof way to gate "is it still
   * safe to auto-correct the base viewBox". */
  const interactedRef = useRef(false)
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

  /** For canvases with no fixed logical coordinate space (the tree editor):
   * (re-)establishes the base viewBox from the SVG's actual rendered pixel
   * box, so world units start out matching CSS pixels 1:1, as they did
   * before pan/zoom. Safe to call repeatedly -- a correction only ever
   * applies until `interactedRef` flips (the user's first real pan/zoom),
   * so later calls never clobber real interaction. Deliberately gated on
   * that plain ref rather than comparing `viewBox` to `baseRef` from
   * *inside* the `setViewBox` updater: React (in dev + StrictMode)
   * double-invokes updater functions to catch impure ones, and an updater
   * that mutates `baseRef` as a side effect desyncs on the second,
   * discarded invocation -- silently freezing the correction after its
   * first successful call. This matters because the tree pane can be
   * collapsed and reopened (see `App.tsx`'s `paneOpen`), which fully
   * unmounts and remounts this canvas while its `.pane` ancestor is still
   * mid-way through its own `flex-grow`/`flex-basis` CSS transition -- a
   * single one-shot read at mount (the old behavior) could freeze in a
   * too-narrow, mid-transition width as the permanent coordinate
   * baseline. `TreeEditorCanvas` re-invokes this from a `ResizeObserver`
   * so it keeps correcting itself across that transition and settles on
   * the true final size once the animation ends, with no need to know the
   * transition's duration or listen for its end. */
  const initializeBase = useCallback((w: number, h: number) => {
    if (interactedRef.current || w <= 0 || h <= 0) return
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
        interactedRef.current = true
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
      interactedRef.current = true
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
