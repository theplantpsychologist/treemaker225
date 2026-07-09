import { useCallback, useMemo, useRef } from 'react'
import type { RefObject, PointerEvent as ReactPointerEvent } from 'react'
import { useAppStore } from '../../state/store'
import { extraRotationFor, getBases, maxProjection } from '../../geometry/shapes'
import { collectResolvedPoints } from '../../geometry/constraintResolution'
import { EDGE_HIT_TOLERANCE_MIN_PX } from '../../constants/sizeTokens'

export const VIEW_SIZE = 500
const CLICK_THRESHOLD = 4
/** How close (in unit-space, as a fraction of the shape's boundary distance
 * at that angle) a pointerdown must land to the shape's edge to be treated
 * as a resize instead of a move — combined with a zoom-invariant absolute
 * floor (see `unitsPerPixel`) so the hit target never shrinks to nothing
 * when zoomed out. */
const EDGE_HIT_FRACTION = 0.15
/** Hard floor on a flap's radius while interactively resizing, in unit-
 * square space (not pixel space, so not a `sizeTokens.ts` entry — it stays a
 * fixed fraction of the paper regardless of zoom). Prevents a drag from
 * shrinking a flap to nothing. */
const MIN_FLAP_RADIUS_UNIT = 1 / 32

type DragKind = 'move' | 'resizeFlap'

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
  /** For a 'move' drag: the constant offset from the cursor's world
   * position to the flap's center, captured once the gesture crosses the
   * click threshold — added back on every subsequent move so the flap
   * displaces by the drag delta instead of jumping to the cursor. */
  offset?: Point
}

export function usePackingEditorInteraction(
  svgRef: RefObject<SVGSVGElement | null>,
  unitsPerPixel: number,
) {
  const packing = useAppStore((s) => s.packing)
  const constraints = useAppStore((s) => s.constraints)
  const tree = useAppStore((s) => s.tree)
  const bases = useAppStore((s) => {
    const extraRotation = extraRotationFor(
      s.hyperparams.shape,
      s.hyperparams.hexagonExtraRotation,
      s.hyperparams.squareExtraRotation,
      s.hyperparams.dodecagonExtraRotation,
    )
    return getBases(s.hyperparams.shape, s.constraints.symmetryMode, extraRotation)
  })
  /** Leaves whose position is fully fixed — either directly (pin_corner) or
   * because a paired partner's own pin mirrors onto them — and therefore
   * must not be interactively dragged (see `moveFlapPositions`'s docstring
   * for why dragging the "derived" side of such a pair would corrupt it). */
  const resolvedFixedLeafIds = useMemo(
    () => new Set(collectResolvedPoints(tree, constraints).map((e) => e.leafId)),
    [tree, constraints],
  )
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
      // The unit square is y-up internally (see geometry/edgePin.ts) but
      // screen pixels are y-down, so invert the same flip rendering applies.
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
          const tolerance = Math.max(EDGE_HIT_TOLERANCE_MIN_PX * unitsPerPixel, boundaryDist * EDGE_HIT_FRACTION)
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
        center,
      }
    },
    [toUnitPoint, pushUndoSnapshot, bases, unitsPerPixel],
  )

  /** A river has no move/resize gesture at all — pointerdown always just
   * selects it (for tree-editor highlighting and the Inspector's width
   * display). Width changes only happen via the tree editor's edge length,
   * to avoid the ungated "any click-drag on an already-selected river
   * resizes it" bug this used to have. */
  const selectRiver = useCallback(
    (nodeId: string) => {
      selectEdge(nodeId)
    },
    [selectEdge],
  )

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

      if (ds.kind === 'move' && !ds.dragging) {
        const dx = e.clientX - ds.startClientX
        const dy = e.clientY - ds.startClientY
        if (Math.hypot(dx, dy) < CLICK_THRESHOLD) return
        ds.dragging = true
        pushUndoSnapshot()
      }

      const p = toUnitPoint(e)
      if (ds.kind === 'move' && ds.center && !ds.offset) {
        ds.offset = { x: ds.center.x - p.x, y: ds.center.y - p.y }
      }
      if (ds.kind === 'move') {
        // Fully-fixed flaps (direct pin_corner, or the mirrored half of a
        // pair whose partner is pinned) are a no-op to drag — the
        // constraint's own projection still applies whenever it's
        // (re)applied programmatically, e.g. right after pinning.
        if (!resolvedFixedLeafIds.has(ds.nodeId) && ds.offset) {
          moveFlap(ds.nodeId, p.x + ds.offset.x, p.y + ds.offset.y)
        }
      } else if (ds.kind === 'resizeFlap' && ds.center && ds.dir) {
        const t = (p.x - ds.center.x) * ds.dir.x + (p.y - ds.center.y) * ds.dir.y
        const radius = Math.max(t * maxProjection(ds.dir, bases), MIN_FLAP_RADIUS_UNIT)
        setEdgeLength(ds.nodeId, radius / packing.scale)
      }
    },
    [toUnitPoint, packing, resolvedFixedLeafIds, moveFlap, setEdgeLength, pushUndoSnapshot, bases],
  )

  const onPointerUp = useCallback(() => {
    const ds = dragState.current
    if (ds && !ds.dragging && ds.kind === 'move') {
      onFlapClicked(ds.nodeId)
    }
    dragState.current = null
  }, [onFlapClicked])

  return { beginFlapPointerDown, selectRiver, onPointerMove, onPointerUp }
}
