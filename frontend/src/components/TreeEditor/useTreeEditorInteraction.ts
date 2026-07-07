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
  const tree = useAppStore((s) => s.tree)
  const selectedNodeId = useAppStore((s) => s.selectedNodeId)
  const selectNode = useAppStore((s) => s.selectNode)
  const createRootAt = useAppStore((s) => s.createRootAt)
  const addChildAt = useAppStore((s) => s.addChildAt)
  const moveNode = useAppStore((s) => s.moveNode)

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
      selectNode(id)
    },
    [toSvgPoint, selectNode],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const ds = dragState.current
      if (!ds) return
      const p = toSvgPoint(e)
      const dx = p.x - ds.startX
      const dy = p.y - ds.startY
      if (!ds.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      ds.dragging = true
      moveNode(ds.id, p.x, p.y)
    },
    [toSvgPoint, moveNode],
  )

  const onPointerUp = useCallback(() => {
    dragState.current = null
  }, [])

  const onBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      const p = toSvgPoint(e)
      if (!tree.rootId) {
        createRootAt(p.x, p.y)
        return
      }
      if (selectedNodeId) {
        addChildAt(selectedNodeId, p.x, p.y)
      }
    },
    [toSvgPoint, tree.rootId, selectedNodeId, createRootAt, addChildAt],
  )

  return { onNodePointerDown, onPointerMove, onPointerUp, onBackgroundPointerDown }
}
