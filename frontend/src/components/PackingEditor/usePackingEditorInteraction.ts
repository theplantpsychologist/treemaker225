import { useCallback, useRef } from 'react'
import type { RefObject, PointerEvent as ReactPointerEvent } from 'react'
import { useAppStore } from '../../state/store'
import { getBases, maxProjection } from '../../geometry/shapes'

export const VIEW_SIZE = 500
const CLICK_THRESHOLD = 4
/** How close (in unit-space, as a fraction of the shape's boundary distance
 * at that angle, with an absolute floor) a pointerdown must land to the
 * shape's edge to be treated as a resize instead of a move. */
const EDGE_HIT_MIN = 0.015
const EDGE_HIT_FRACTION = 0.15

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
  dir?: Point
  p1?: Point
  p2?: Point
}

export function usePackingEditorInteraction(svgRef: RefObject<SVGSVGElement | null>) {
  const packing = useAppStore((s) => s.packing)
  const constraints = useAppStore((s) => s.constraints)
  const bases = useAppStore((s) => getBases(s.hyperparams.shape))
  const moveFlap = useAppStore((s) => s.moveFlap)
  const setEdgeLength = useAppStore((s) => s.setEdgeLength)
  const pairingSourceId = useAppStore((s) => s.pairingSourceId)
  const selectEdge = useAppStore((s) => s.selectEdge)
  const pairFlaps = useAppStore((s) => s.pairFlaps)
  const pushUndoSnapshot = useAppStore((s) => s.pushUndoSnapshot)

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

  /** A flap pointerdown is a resize when the flap is already selected AND the
   * click landed near its boundary; otherwise it's the usual click-selects /
   * drag-moves gesture (unchanged for unselected flaps). */
  const beginFlapPointerDown = useCallback(
    (nodeId: string, center: Point, radius: number, isSelected: boolean, e: ReactPointerEvent) => {
      capture(e)
      if (isSelected) {
        const p = toUnitPoint(e)
        const dx = p.x - center.x
        const dy = p.y - center.y
        const clickDist = Math.hypot(dx, dy)
        if (clickDist > 1e-6) {
          const dir = { x: dx / clickDist, y: dy / clickDist }
          const boundaryDist = radius / maxProjection(dir, bases)
          const tolerance = Math.max(EDGE_HIT_MIN, boundaryDist * EDGE_HIT_FRACTION)
          if (Math.abs(clickDist - boundaryDist) < tolerance) {
            pushUndoSnapshot()
            dragState.current = {
              kind: 'resizeFlap',
              nodeId,
              startClientX: e.clientX,
              startClientY: e.clientY,
              dragging: true,
              center,
              dir,
            }
            return
          }
        }
      }
      dragState.current = {
        kind: 'move',
        nodeId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        dragging: false,
      }
    },
    [toUnitPoint, pushUndoSnapshot, bases],
  )

  const beginResizeRiver = useCallback((nodeId: string, p1: Point, p2: Point, e: ReactPointerEvent) => {
    capture(e)
    dragState.current = {
      kind: 'resizeRiver',
      nodeId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      dragging: false,
      p1,
      p2,
    }
  }, [])

  const onFlapClicked = useCallback(
    (nodeId: string) => {
      if (pairingSourceId && pairingSourceId !== nodeId) {
        pairFlaps(pairingSourceId, nodeId)
      } else {
        selectEdge(nodeId)
      }
    },
    [pairingSourceId, pairFlaps, selectEdge],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const ds = dragState.current
      if (!ds || !packing) return

      if ((ds.kind === 'move' || ds.kind === 'resizeRiver') && !ds.dragging) {
        const dx = e.clientX - ds.startClientX
        const dy = e.clientY - ds.startClientY
        if (Math.hypot(dx, dy) < CLICK_THRESHOLD) return
        ds.dragging = true
        pushUndoSnapshot()
      }

      const p = toUnitPoint(e)
      if (ds.kind === 'move') {
        // pin_corner flaps are fully fixed — interactive dragging is a no-op
        // (the constraint's own projection still applies whenever it's
        // (re)applied programmatically, e.g. right after pinning).
        if (constraints.perLeaf[ds.nodeId]?.kind !== 'pin_corner') {
          moveFlap(ds.nodeId, p.x, p.y)
        }
      } else if (ds.kind === 'resizeFlap' && ds.center && ds.dir) {
        const t = (p.x - ds.center.x) * ds.dir.x + (p.y - ds.center.y) * ds.dir.y
        const radius = t * maxProjection(ds.dir, bases)
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
    [toUnitPoint, packing, constraints, moveFlap, setEdgeLength, pushUndoSnapshot, bases],
  )

  const onPointerUp = useCallback(() => {
    const ds = dragState.current
    if (ds && !ds.dragging) {
      if (ds.kind === 'move') onFlapClicked(ds.nodeId)
      else if (ds.kind === 'resizeRiver') selectEdge(ds.nodeId)
    }
    dragState.current = null
  }, [onFlapClicked, selectEdge])

  return { beginFlapPointerDown, beginResizeRiver, onPointerMove, onPointerUp }
}
