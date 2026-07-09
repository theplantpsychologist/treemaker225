import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useAppStore } from '../../state/store'
import { buildShapePoints, extraRotationFor } from '../../geometry/shapes'
import { computeRiverBands, ringsToPathD } from '../../geometry/rivers'
import { computeOverlapAreas } from '../../geometry/overlap'
import { computeActivePaths } from '../../geometry/activePaths'
import { COLOR_OVERLAP } from '../../constants/constraintColors'
import { isPackingStale } from '../../geometry/topology'
import { isPointOccupied } from '../../geometry/constraintResolution'
import { cornerPosition } from '../../geometry/edgePin'
import type { CornerId, EdgeSide } from '../../types/constraints'
import { Inspector } from './Inspector'
import { SolvingOverlay } from './SolvingOverlay'
import { usePackingEditorInteraction, VIEW_SIZE } from './usePackingEditorInteraction'
import { useViewBoxPanZoom } from '../../hooks/useViewBoxPanZoom'
import {
  CENTER_DOT_RADIUS_PX,
  CORNER_PIN_HANDLE_SIZE_PX,
  EDGE_PIN_HANDLE_THICKNESS_PX,
} from '../../constants/sizeTokens'
import './PackingEditor.css'

/** The unit square is y-up internally (see geometry/edgePin.ts); flip y so
 * it renders right-side up in screen space. */
function toPointsAttr(points: [number, number][], scale: number): string {
  return points.map(([x, y]) => `${x * scale},${(1 - y) * scale}`).join(' ')
}

function toScreen(x: number, y: number): [number, number] {
  return [x * VIEW_SIZE, (1 - y) * VIEW_SIZE]
}

interface FlapInfo {
  key: string
  center: { x: number; y: number }
  radius: number
  points: string
  /** No constraint at all (symmetry/boundary/locked all 'none') — rendered
   * desaturated (see `.packing-flap.unconstrained` in PackingEditor.css). */
  constrained: boolean
}

interface RiverInfo {
  key: string
  nodeId: string
  pathD: string
}

const EDGE_SIDES: EdgeSide[] = ['top', 'bottom', 'left', 'right']
const CORNER_IDS: CornerId[] = ['top_left', 'top_right', 'bottom_left', 'bottom_right']

/** A clickable band spanning the entire paper edge, in VIEW_SIZE-scaled
 * coordinates — easier to hit than a small midpoint marker. */
function edgeHandleRect(edge: EdgeSide, thickness: number) {
  switch (edge) {
    case 'top':
      return { x: 0, y: 0, width: VIEW_SIZE, height: thickness }
    case 'bottom':
      return { x: 0, y: VIEW_SIZE - thickness, width: VIEW_SIZE, height: thickness }
    case 'left':
      return { x: 0, y: 0, width: thickness, height: VIEW_SIZE }
    case 'right':
      return { x: VIEW_SIZE - thickness, y: 0, width: thickness, height: VIEW_SIZE }
  }
}

export function PackingEditorCanvas() {
  const svgRef = useRef<SVGSVGElement>(null)
  const tree = useAppStore((s) => s.tree)
  const packing = useAppStore((s) => s.packing)
  const shape = useAppStore((s) => s.hyperparams.shape)
  const hexagonExtraRotation = useAppStore((s) => s.hyperparams.hexagonExtraRotation)
  const squareExtraRotation = useAppStore((s) => s.hyperparams.squareExtraRotation)
  const dodecagonExtraRotation = useAppStore((s) => s.hyperparams.dodecagonExtraRotation)
  const extraRotation = extraRotationFor(shape, hexagonExtraRotation, squareExtraRotation, dodecagonExtraRotation)
  const activeSnapLengthTolerance = useAppStore((s) => s.hyperparams.activeSnapLengthTolerance)
  const activeSnapAngleTolerance = useAppStore((s) => s.hyperparams.activeSnapAngleTolerance)
  const clipToSquare = useAppStore((s) => s.clipToSquare)
  const constraints = useAppStore((s) => s.constraints)
  const selectedEdgeId = useAppStore((s) => s.selectedEdgeId)
  const selectEdge = useAppStore((s) => s.selectEdge)
  const pinTargetMode = useAppStore((s) => s.pinTargetMode)
  const cancelPinTarget = useAppStore((s) => s.cancelPinTarget)
  const pinToEdge = useAppStore((s) => s.pinToEdge)
  const pinToCorner = useAppStore((s) => s.pinToCorner)
  const pan = useViewBoxPanZoom(svgRef, { x: 0, y: 0, w: VIEW_SIZE, h: VIEW_SIZE })
  const unitsPerPixel = pan.pxToWorld / VIEW_SIZE
  const { beginFlapPointerDown, selectRiver, onPointerMove, onPointerUp } =
    usePackingEditorInteraction(svgRef, unitsPerPixel)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pinTargetMode) cancelPinTarget()
        else selectEdge(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pinTargetMode, cancelPinTarget, selectEdge])

  // Staleness is now rare (the store maintains a packing-position invariant
  // on every add/delete) but still needs a defensive, dismissible banner —
  // e.g. for a hand-edited import. Dismissal is transient per-episode UI
  // state, not a store field, and re-arms whenever a NEW staleness episode
  // begins (edge-detected on the false->true transition of `stale`).
  const [staleDismissed, setStaleDismissed] = useState(false)
  const wasStale = useRef(false)

  const onBackgroundPointerDown = (e: ReactPointerEvent<SVGRectElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // best-effort
    }
    pan.beginPan(e)
  }
  const onSvgPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    onPointerMove(e)
    pan.onPanMove(e)
  }
  const onSvgPointerUp = () => {
    onPointerUp()
    if (pan.endPan() === 'click') {
      if (pinTargetMode) cancelPinTarget()
      else selectEdge(null)
    }
  }

  const { flaps, rivers } = useMemo(() => {
    const flapList: FlapInfo[] = []
    const riverList: RiverInfo[] = []
    if (!packing) return { flaps: flapList, rivers: riverList }

    const bands = computeRiverBands(tree, packing.positions, packing.scale, shape, constraints.symmetryMode, extraRotation)
    const pathByNodeId = new Map(bands.map((b) => [b.nodeId, ringsToPathD(b.rings, VIEW_SIZE)]))

    for (const node of Object.values(tree.nodes)) {
      if (!node.parentId || node.length == null) continue
      const parentPos = packing.positions[node.parentId]
      const childPos = packing.positions[node.id]
      if (!parentPos || !childPos) continue

      const width = packing.scale * node.length
      if (node.children.length === 0) {
        const shapePoints = buildShapePoints(shape, childPos.x, childPos.y, width, constraints.symmetryMode, extraRotation)
        flapList.push({
          key: node.id,
          center: childPos,
          radius: width,
          points: toPointsAttr(shapePoints, VIEW_SIZE),
          constrained: constraints.perLeaf[node.id] != null,
        })
      } else {
        const pathD = pathByNodeId.get(node.id)
        if (pathD == null) continue
        riverList.push({
          key: node.id,
          nodeId: node.id,
          pathD,
        })
      }
    }
    return { flaps: flapList, rivers: riverList }
  }, [tree, packing, constraints, shape, extraRotation])

  const overlapAreas = useMemo(() => {
    if (!packing) return []
    return computeOverlapAreas(tree, packing.positions, packing.scale, shape, constraints.symmetryMode, extraRotation)
  }, [tree, packing, shape, constraints.symmetryMode, extraRotation])

  const activePaths = useMemo(() => {
    if (!packing) return []
    return computeActivePaths(
      tree,
      packing.positions,
      packing.scale,
      shape,
      constraints.symmetryMode,
      extraRotation,
      activeSnapLengthTolerance,
      activeSnapAngleTolerance,
    )
  }, [tree, packing, shape, constraints.symmetryMode, extraRotation, activeSnapLengthTolerance, activeSnapAngleTolerance])

  const stale = useMemo(() => isPackingStale(tree, packing), [tree, packing])
  useEffect(() => {
    if (stale && !wasStale.current) setStaleDismissed(false)
    wasStale.current = stale
  }, [stale])

  return (
    <div className="packing-editor-wrapper">
      <div className="packing-editor-stage">
      <svg
        ref={svgRef}
        className="packing-editor-canvas"
        viewBox={pan.viewBoxAttr}
        onPointerMove={onSvgPointerMove}
        onPointerUp={onSvgPointerUp}
        onPointerLeave={onSvgPointerUp}
      >
        <defs>
          <clipPath id="packing-square-clip">
            <rect x={0} y={0} width={VIEW_SIZE} height={VIEW_SIZE} />
          </clipPath>
        </defs>
        <rect
          className="packing-editor-backdrop"
          x={pan.viewBox.x}
          y={pan.viewBox.y}
          width={pan.viewBox.w}
          height={pan.viewBox.h}
          onPointerDown={onBackgroundPointerDown}
        />
        <rect
          className="packing-square"
          x={0}
          y={0}
          width={VIEW_SIZE}
          height={VIEW_SIZE}
          onPointerDown={onBackgroundPointerDown}
        />

        {constraints.symmetryMode === 'book' && (
          <line className="symmetry-line" x1={VIEW_SIZE / 2} y1={0} x2={VIEW_SIZE / 2} y2={VIEW_SIZE} />
        )}
        {constraints.symmetryMode === 'diagonal' && (
          // The line x=y in the y-up unit square runs bottom-left to
          // top-right — after the render-time y-flip that's screen (0,
          // VIEW_SIZE) to (VIEW_SIZE, 0).
          <line className="symmetry-line" x1={0} y1={VIEW_SIZE} x2={VIEW_SIZE} y2={0} />
        )}

        <g clipPath={clipToSquare ? 'url(#packing-square-clip)' : undefined}>
          {activePaths.map((p) =>
            p.kind === 'active' ? (
              (() => {
                const [x1, y1] = toScreen(p.ax, p.ay)
                const [x2, y2] = toScreen(p.bx, p.by)
                return <line key={`active-${p.a}-${p.b}`} className="active-path" x1={x1} y1={y1} x2={x2} y2={y2} />
              })()
            ) : (
              <polygon
                key={`active-${p.a}-${p.b}`}
                className="active-path-semi"
                points={toPointsAttr(p.points, VIEW_SIZE)}
              />
            ),
          )}

          {rivers.map((r) => (
            <g key={`river-${r.key}`}>
              <path
                className={'packing-river' + (r.key === selectedEdgeId ? ' selected' : '')}
                fillRule="evenodd"
                d={r.pathD}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  selectRiver(r.nodeId)
                }}
              />
            </g>
          ))}

          {flaps.map((f) => (
            <g key={`flap-${f.key}`}>
              <polygon
                className={
                  'packing-flap' +
                  (f.key === selectedEdgeId ? ' selected' : '') +
                  (f.constrained ? '' : ' unconstrained')
                }
                points={f.points}
                onPointerDown={(e) => beginFlapPointerDown(f.key, f.center, f.radius, f.key === selectedEdgeId, e)}
              />
              <circle
                className="center-dot"
                cx={f.center.x * VIEW_SIZE}
                cy={(1 - f.center.y) * VIEW_SIZE}
                r={CENTER_DOT_RADIUS_PX * pan.pxToWorld}
              />
            </g>
          ))}

          {overlapAreas.map(({ a, b, rings }) => (
            <path
              key={`overlap-${a}-${b}`}
              className="overlap-area"
              style={{ fill: `${COLOR_OVERLAP}99` }}
              fillRule="evenodd"
              d={ringsToPathD(rings, VIEW_SIZE)}
            />
          ))}
        </g>

        {selectedEdgeId &&
          pinTargetMode === 'edge' &&
          EDGE_SIDES.map((edge) => {
            const thickness = EDGE_PIN_HANDLE_THICKNESS_PX * pan.pxToWorld
            const rect = edgeHandleRect(edge, thickness)
            return (
              <rect
                key={`edge-handle-${edge}`}
                className="pin-handle pin-handle-edge"
                x={rect.x}
                y={rect.y}
                width={rect.width}
                height={rect.height}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => pinToEdge(selectedEdgeId, edge)}
              />
            )
          })}

        {selectedEdgeId &&
          pinTargetMode === 'corner' &&
          CORNER_IDS.map((corner) => {
            const size = CORNER_PIN_HANDLE_SIZE_PX * pan.pxToWorld
            const p = cornerPosition(corner)
            const occupied = isPointOccupied(tree, constraints, p, selectedEdgeId)
            const screenX = p.x * VIEW_SIZE
            const screenY = (1 - p.y) * VIEW_SIZE
            return (
              <rect
                key={`corner-handle-${corner}`}
                className={'pin-handle pin-handle-corner' + (occupied ? ' occupied' : '')}
                x={screenX - size / 2}
                y={screenY - size / 2}
                width={size}
                height={size}
                transform={`rotate(45 ${screenX} ${screenY})`}
                onPointerDown={(e) => (occupied ? undefined : e.stopPropagation())}
                onClick={() => (occupied ? undefined : pinToCorner(selectedEdgeId, corner))}
              />
            )
          })}
      </svg>
      {/* {packing && <div className="scale-badge">scale: {packing.scale.toFixed(4)}</div>} */}
      {/* {!packing && <div className="packing-empty-hint">Click Initialize to lay out the packing</div>}
      {packing?.diagnostics.kind === 'naive' && (
        <div className="packing-empty-hint">Preview — click Optimize to refine</div>
      )} */}
      {stale && !staleDismissed && (
        <div className="stale-banner">
          Tree changed — re-initialize or optimize to update the packing
          <button className="dismiss-error" onClick={() => setStaleDismissed(true)}>
            ×
          </button>
        </div>
      )}
      <SolvingOverlay />
      </div>
      <Inspector />
    </div>
  )
}
