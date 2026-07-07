import { useCallback, useRef } from 'react'
import type { RefObject, PointerEvent as ReactPointerEvent } from 'react'
import { useAppStore } from '../../state/store'

export const VIEW_SIZE = 500
const CLICK_THRESHOLD = 4

type DragKind = 'move' | 'resizeFlap' | 'resizeRiver'

interface Point {
  x: number
  y: number
}

interface DragState {
  kind: DragKind
  nodeId: string
  startClientX: number
  startClientY: number
  dragging: boolean
  center?: Point
  p1?: Point
  p2?: Point
}

export function usePackingEditorInteraction(svgRef: RefObject<SVGSVGElement | null>) {
  const packing = useAppStore((s) => s.packing)
  const constraints = useAppStore((s) => s.constraints)
  const moveFlap = useAppStore((s) => s.moveFlap)
  const setEdgeLength = useAppStore((s) => s.setEdgeLength)
  const pairingSourceId = useAppStore((s) => s.pairingSourceId)
  const selectFlap = useAppStore((s) => s.selectFlap)
  const pairFlaps = useAppStore((s) => s.pairFlaps)

  const dragState = useRef<DragState | null>(null)

  const toUnitPoint = useCallback(
    (e: ReactPointerEvent): Point => {
      const svg = svgRef.current!
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const ctm = svg.getScreenCTM()!.inverse()
      const transformed = pt.matrixTransform(ctm)
      return { x: transformed.x / VIEW_SIZE, y: transformed.y / VIEW_SIZE }
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

  const beginMoveFlap = useCallback((nodeId: string, e: ReactPointerEvent) => {
    capture(e)
    dragState.current = {
      kind: 'move',
      nodeId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      dragging: false,
    }
  }, [])

  const beginResizeFlap = useCallback((nodeId: string, center: Point, e: ReactPointerEvent) => {
    capture(e)
    dragState.current = {
      kind: 'resizeFlap',
      nodeId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      dragging: true,
      center,
    }
  }, [])

  const beginResizeRiver = useCallback((nodeId: string, p1: Point, p2: Point, e: ReactPointerEvent) => {
    capture(e)
    dragState.current = {
      kind: 'resizeRiver',
      nodeId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      dragging: true,
      p1,
      p2,
    }
  }, [])

  const onFlapClicked = useCallback(
    (nodeId: string) => {
      if (pairingSourceId && pairingSourceId !== nodeId) {
        pairFlaps(pairingSourceId, nodeId)
      } else {
        selectFlap(nodeId)
      }
    },
    [pairingSourceId, pairFlaps, selectFlap],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const ds = dragState.current
      if (!ds || !packing) return

      if (ds.kind === 'move' && !ds.dragging) {
        const dx = e.clientX - ds.startClientX
        const dy = e.clientY - ds.startClientY
        if (Math.hypot(dx, dy) < CLICK_THRESHOLD) return
        ds.dragging = true
      }

      const p = toUnitPoint(e)
      if (ds.kind === 'move') {
        // pin_corner flaps are fully fixed — interactive dragging is a no-op
        // (the constraint's own projection still applies whenever it's
        // (re)applied programmatically, e.g. right after pinning).
        if (constraints.perLeaf[ds.nodeId]?.kind !== 'pin_corner') {
          moveFlap(ds.nodeId, p.x, p.y)
        }
      } else if (ds.kind === 'resizeFlap' && ds.center) {
        const radius = Math.hypot(p.x - ds.center.x, p.y - ds.center.y)
        setEdgeLength(ds.nodeId, Math.max(radius / packing.scale, 1e-6))
      } else if (ds.kind === 'resizeRiver' && ds.p1 && ds.p2) {
        const dx = ds.p2.x - ds.p1.x
        const dy = ds.p2.y - ds.p1.y
        const len = Math.hypot(dx, dy) || 1e-9
        const nx = -dy / len
        const ny = dx / len
        const mx = (ds.p1.x + ds.p2.x) / 2
        const my = (ds.p1.y + ds.p2.y) / 2
        const perp = (p.x - mx) * nx + (p.y - my) * ny
        const width = Math.abs(perp) * 2
        setEdgeLength(ds.nodeId, Math.max(width / packing.scale, 1e-6))
      }
    },
    [toUnitPoint, packing, constraints, moveFlap, setEdgeLength],
  )

  const onPointerUp = useCallback(() => {
    const ds = dragState.current
    if (ds && ds.kind === 'move' && !ds.dragging) {
      onFlapClicked(ds.nodeId)
    }
    dragState.current = null
  }, [onFlapClicked])

  return { beginMoveFlap, beginResizeFlap, beginResizeRiver, onPointerMove, onPointerUp }
}
