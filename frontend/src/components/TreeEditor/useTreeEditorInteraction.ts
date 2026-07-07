import { useCallback, useRef } from 'react'
import type { RefObject, PointerEvent as ReactPointerEvent } from 'react'
import { useAppStore } from '../../state/store'

const DRAG_THRESHOLD = 4

interface DragState {
  id: string
  startX: number
  startY: number
  dragging: boolean
}

export function useTreeEditorInteraction(svgRef: RefObject<SVGSVGElement | null>) {
  const selectTreeNode = useAppStore((s) => s.selectTreeNode)
  const moveNode = useAppStore((s) => s.moveNode)
  const pushUndoSnapshot = useAppStore((s) => s.pushUndoSnapshot)

  const dragState = useRef<DragState | null>(null)

  const toSvgPoint = useCallback(
    (e: ReactPointerEvent) => {
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

  const onNodePointerDown = useCallback(
    (id: string, e: ReactPointerEvent) => {
      e.stopPropagation()
      try {
        ;(e.target as Element).setPointerCapture(e.pointerId)
      } catch {
        // Pointer capture is best-effort (keeps drag tracking a fast pointer that
        // leaves the canvas); some environments reject it, which shouldn't block the drag itself.
      }
      const p = toSvgPoint(e)
      dragState.current = { id, startX: p.x, startY: p.y, dragging: false }
      selectTreeNode(id)
    },
    [toSvgPoint, selectTreeNode],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const ds = dragState.current
      if (!ds) return
      const p = toSvgPoint(e)
      const dx = p.x - ds.startX
      const dy = p.y - ds.startY
      if (!ds.dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
        ds.dragging = true
        pushUndoSnapshot()
      }
      moveNode(ds.id, p.x, p.y)
    },
    [toSvgPoint, moveNode, pushUndoSnapshot],
  )

  const onPointerUp = useCallback(() => {
    dragState.current = null
  }, [])

  return { onNodePointerDown, onPointerMove, onPointerUp }
}
