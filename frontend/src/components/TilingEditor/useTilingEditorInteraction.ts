import { useCallback, useRef } from 'react'
import type { RefObject, PointerEvent as ReactPointerEvent } from 'react'
import { useAppStore } from '../../state/store'

export const VIEW_SIZE = 500
const CLICK_THRESHOLD = 4

interface Point {
  x: number
  y: number
}

interface DragState {
  vertexId: string
  startClientX: number
  startClientY: number
  dragging: boolean
  /** Captured at pointerdown, not pointerup -- the user's intent for a
   * plain vs. additive click is set the moment the gesture starts. */
  shiftKey: boolean
}

/** Pointer/click/drag handling for the manual tiling editor's vertices and
 * legs -- mirrors `usePackingEditorInteraction`'s click-vs-drag-threshold +
 * pointer-capture pattern, simplified: a vertex only ever moves (no
 * resize), and a leg is click-to-select only (never dragged). Dragging is
 * pure client-side null-space projection (`projectVertexDrag`, called via
 * the store's `dragTilingVertexTo`) -- no network round trip, so every
 * pointermove frame is synchronous. */
export function useTilingEditorInteraction(svgRef: RefObject<SVGSVGElement | null>) {
  const selectTilingVertex = useAppStore((s) => s.selectTilingVertex)
  const selectTilingLeg = useAppStore((s) => s.selectTilingLeg)
  const dragTilingVertexStart = useAppStore((s) => s.dragTilingVertexStart)
  const dragTilingVertexTo = useAppStore((s) => s.dragTilingVertexTo)
  const runTilingCleanup = useAppStore((s) => s.runTilingCleanup)

  const dragState = useRef<DragState | null>(null)

  const toUnitPoint = useCallback(
    (e: ReactPointerEvent): Point => {
      const svg = svgRef.current!
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const ctm = svg.getScreenCTM()!.inverse()
      const transformed = pt.matrixTransform(ctm)
      return { x: transformed.x / VIEW_SIZE, y: 1 - transformed.y / VIEW_SIZE }
    },
    [svgRef],
  )

  const capture = (e: ReactPointerEvent) => {
    e.stopPropagation()
    try {
      ;(e.target as Element).setPointerCapture(e.pointerId)
    } catch {
      // best-effort; drag still works via svg-level move/up listeners
    }
  }

  const beginVertexPointerDown = useCallback((vertexId: string, e: ReactPointerEvent) => {
    capture(e)
    dragState.current = { vertexId, startClientX: e.clientX, startClientY: e.clientY, dragging: false, shiftKey: e.shiftKey }
  }, [])

  const onLegPointerDown = useCallback(
    (legId: string, e: ReactPointerEvent) => {
      e.stopPropagation()
      selectTilingLeg(legId)
    },
    [selectTilingLeg],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const ds = dragState.current
      if (!ds) return

      if (!ds.dragging) {
        const dx = e.clientX - ds.startClientX
        const dy = e.clientY - ds.startClientY
        if (Math.hypot(dx, dy) < CLICK_THRESHOLD) return
        ds.dragging = true
        dragTilingVertexStart()
      }

      const p = toUnitPoint(e)
      dragTilingVertexTo(ds.vertexId, p.x, p.y)
    },
    [toUnitPoint, dragTilingVertexStart, dragTilingVertexTo],
  )

  const onPointerUp = useCallback(() => {
    const ds = dragState.current
    if (ds && !ds.dragging) {
      selectTilingVertex(ds.vertexId, ds.shiftKey)
    }
    dragState.current = null
    // Running cleanup after every pointerup, drag or plain click alike (a
    // plain click is a cheap no-op fast path -- see `runTilingCleanup`'s
    // own doc for why nothing moved means nothing to clean).
    runTilingCleanup()
  }, [selectTilingVertex, runTilingCleanup])

  return { beginVertexPointerDown, onLegPointerDown, onPointerMove, onPointerUp }
}
