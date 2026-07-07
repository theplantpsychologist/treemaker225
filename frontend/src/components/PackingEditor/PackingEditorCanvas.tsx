import { useEffect, useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useAppStore } from '../../state/store'
import { buildShapePoints } from '../../geometry/shapes'
import { computeRiverBands, ringsToPathD } from '../../geometry/rivers'
import { findAllOverlaps } from '../../geometry/overlap'
import { colorForConstraint } from '../../constants/constraintColors'
import { isPackingStale } from '../../geometry/topology'
import type { CornerId, EdgeSide } from '../../types/constraints'
import { Inspector } from './Inspector'
import { usePackingEditorInteraction, VIEW_SIZE } from './usePackingEditorInteraction'
import { useViewBoxPanZoom } from '../../hooks/useViewBoxPanZoom'
import './PackingEditor.css'

function toPointsAttr(points: [number, number][], scale: number): string {
  return points.map(([x, y]) => `${x * scale},${y * scale}`).join(' ')
}

interface FlapInfo {
  key: string
  center: { x: number; y: number }
  radius: number
  points: string
  color: string
}

interface RiverInfo {
  key: string
  nodeId: string
  p1: { x: number; y: number }
  p2: { x: number; y: number }
  pathD: string
  handle: { x: number; y: number }
}

const EDGE_HANDLES: { edge: EdgeSide; x: number; y: number }[] = [
  { edge: 'top', x: 0.5, y: 0 },
  { edge: 'bottom', x: 0.5, y: 1 },
  { edge: 'left', x: 0, y: 0.5 },
  { edge: 'right', x: 1, y: 0.5 },
]

const CORNER_HANDLES: { corner: CornerId; x: number; y: number }[] = [
  { corner: 'top_left', x: 0, y: 0 },
  { corner: 'top_right', x: 1, y: 0 },
  { corner: 'bottom_left', x: 0, y: 1 },
  { corner: 'bottom_right', x: 1, y: 1 },
]

export function PackingEditorCanvas() {
  const svgRef = useRef<SVGSVGElement>(null)
  const tree = useAppStore((s) => s.tree)
  const packing = useAppStore((s) => s.packing)
  const shape = useAppStore((s) => s.hyperparams.shape)
  const constraints = useAppStore((s) => s.constraints)
  const selectedEdgeId = useAppStore((s) => s.selectedEdgeId)
  const selectEdge = useAppStore((s) => s.selectEdge)
  const pinTargetMode = useAppStore((s) => s.pinTargetMode)
  const cancelPinTarget = useAppStore((s) => s.cancelPinTarget)
  const pinToEdge = useAppStore((s) => s.pinToEdge)
  const pinToCorner = useAppStore((s) => s.pinToCorner)
  const { beginFlapPointerDown, beginResizeRiver, onPointerMove, onPointerUp } =
    usePackingEditorInteraction(svgRef)
  const pan = useViewBoxPanZoom(svgRef, { x: 0, y: 0, w: VIEW_SIZE, h: VIEW_SIZE })

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

    const bands = computeRiverBands(tree, packing.positions, packing.scale, shape)
    const pathByNodeId = new Map(bands.map((b) => [b.nodeId, ringsToPathD(b.rings, VIEW_SIZE)]))

    for (const node of Object.values(tree.nodes)) {
      if (!node.parentId || node.length == null) continue
      const parentPos = packing.positions[node.parentId]
      const childPos = packing.positions[node.id]
      if (!parentPos || !childPos) continue

      const width = packing.scale * node.length
      if (node.children.length === 0) {
        const shapePoints = buildShapePoints(shape, childPos.x, childPos.y, width)
        flapList.push({
          key: node.id,
          center: childPos,
          radius: width,
          points: toPointsAttr(shapePoints, VIEW_SIZE),
          color: colorForConstraint(node.id, constraints.perLeaf[node.id]),
        })
      } else {
        const pathD = pathByNodeId.get(node.id)
        if (pathD == null) continue
        const dx = childPos.x - parentPos.x
        const dy = childPos.y - parentPos.y
        const len = Math.hypot(dx, dy) || 1e-9
        const nx = -dy / len
        const ny = dx / len
        const mx = (parentPos.x + childPos.x) / 2
        const my = (parentPos.y + childPos.y) / 2
        riverList.push({
          key: node.id,
          nodeId: node.id,
          p1: parentPos,
          p2: childPos,
          pathD,
          handle: { x: mx + (nx * width) / 2, y: my + (ny * width) / 2 },
        })
      }
    }
    return { flaps: flapList, rivers: riverList }
  }, [tree, packing, constraints, shape])

  const overlaps = useMemo(() => {
    if (!packing) return []
    return findAllOverlaps(tree, packing.positions, packing.scale, shape)
  }, [tree, packing, shape])

  const stale = useMemo(() => isPackingStale(tree, packing), [tree, packing])

  return (
    <div className="packing-editor-wrapper">
      <svg
        ref={svgRef}
        className={'packing-editor-canvas' + (stale ? ' stale' : '')}
        viewBox={pan.viewBoxAttr}
        onPointerMove={onSvgPointerMove}
        onPointerUp={onSvgPointerUp}
        onPointerLeave={onSvgPointerUp}
      >
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
          <line className="symmetry-line" x1={0} y1={0} x2={VIEW_SIZE} y2={VIEW_SIZE} />
        )}

        {rivers.map((r) => (
          <g key={`river-${r.key}`}>
            <path
              className={'packing-river' + (r.key === selectedEdgeId ? ' selected' : '')}
              fillRule="evenodd"
              d={r.pathD}
              onPointerDown={(e) => beginResizeRiver(r.nodeId, r.p1, r.p2, e)}
            />
            <circle
              className="river-handle"
              cx={r.handle.x * VIEW_SIZE}
              cy={r.handle.y * VIEW_SIZE}
              r={5}
              onPointerDown={(e) => beginResizeRiver(r.nodeId, r.p1, r.p2, e)}
            />
          </g>
        ))}

        {flaps.map((f) => (
          <g key={`flap-${f.key}`}>
            <polygon
              className={'packing-flap' + (f.key === selectedEdgeId ? ' selected' : '')}
              style={{ stroke: f.color, fill: `${f.color}26` }}
              points={f.points}
              onPointerDown={(e) => beginFlapPointerDown(f.key, f.center, f.radius, f.key === selectedEdgeId, e)}
            />
          </g>
        ))}

        {selectedEdgeId &&
          pinTargetMode === 'edge' &&
          EDGE_HANDLES.map((h) => (
            <rect
              key={`edge-handle-${h.edge}`}
              className="pin-handle"
              x={h.x * VIEW_SIZE - 6}
              y={h.y * VIEW_SIZE - 6}
              width={12}
              height={12}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => pinToEdge(selectedEdgeId, h.edge)}
            />
          ))}

        {selectedEdgeId &&
          pinTargetMode === 'corner' &&
          CORNER_HANDLES.map((h) => (
            <rect
              key={`corner-handle-${h.corner}`}
              className="pin-handle pin-handle-corner"
              x={h.x * VIEW_SIZE - 7}
              y={h.y * VIEW_SIZE - 7}
              width={14}
              height={14}
              transform={`rotate(45 ${h.x * VIEW_SIZE} ${h.y * VIEW_SIZE})`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => pinToCorner(selectedEdgeId, h.corner)}
            />
          ))}

        {packing &&
          overlaps.map(({ a, b }) => {
            const pa = packing.positions[a]
            const pb = packing.positions[b]
            return (
              <line
                key={`overlap-${a}-${b}`}
                className="overlap-line"
                x1={pa.x * VIEW_SIZE}
                y1={pa.y * VIEW_SIZE}
                x2={pb.x * VIEW_SIZE}
                y2={pb.y * VIEW_SIZE}
              />
            )
          })}
      </svg>
      {packing && <div className="scale-badge">scale: {packing.scale.toFixed(4)}</div>}
      {!packing && <div className="packing-empty-hint">Run the solver to see the packing</div>}
      {stale && <div className="stale-banner">Tree changed — re-run the solver to update the packing</div>}
      <Inspector />
    </div>
  )
}
