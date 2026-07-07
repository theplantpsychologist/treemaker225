import { useMemo, useRef } from 'react'
import { useAppStore } from '../../state/store'
import { buildOctagonPoints } from '../../geometry/octagon'
import { riverPolygon } from '../../geometry/river'
import { findAllOverlaps } from '../../geometry/overlap'
import { colorForConstraint } from '../../constants/constraintColors'
import type { CornerId, EdgeSide } from '../../types/constraints'
import { ConstraintPanel } from './ConstraintPanel'
import { usePackingEditorInteraction, VIEW_SIZE } from './usePackingEditorInteraction'
import './PackingEditor.css'

function toPointsAttr(points: [number, number][], scale: number): string {
  return points.map(([x, y]) => `${x * scale},${y * scale}`).join(' ')
}

interface FlapInfo {
  key: string
  center: { x: number; y: number }
  radius: number
  points: string
  handle: { x: number; y: number }
  color: string
}

interface RiverInfo {
  key: string
  nodeId: string
  p1: { x: number; y: number }
  p2: { x: number; y: number }
  points: string
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
  const constraints = useAppStore((s) => s.constraints)
  const selectedFlapId = useAppStore((s) => s.selectedFlapId)
  const pinToEdge = useAppStore((s) => s.pinToEdge)
  const pinToCorner = useAppStore((s) => s.pinToCorner)
  const { beginMoveFlap, beginResizeFlap, beginResizeRiver, onPointerMove, onPointerUp } =
    usePackingEditorInteraction(svgRef)

  const { flaps, rivers } = useMemo(() => {
    const flapList: FlapInfo[] = []
    const riverList: RiverInfo[] = []
    if (!packing) return { flaps: flapList, rivers: riverList }

    for (const node of Object.values(tree.nodes)) {
      if (!node.parentId || node.length == null) continue
      const parentPos = packing.positions[node.parentId]
      const childPos = packing.positions[node.id]
      if (!parentPos || !childPos) continue

      const width = packing.scale * node.length
      if (node.children.length === 0) {
        const octagon = buildOctagonPoints(childPos.x, childPos.y, width)
        // Point the handle toward the square's center so it stays reachable
        // even when the flap itself spills past the paper edge.
        const towardCenterX = 0.5 - childPos.x
        const towardCenterY = 0.5 - childPos.y
        const towardCenterLen = Math.hypot(towardCenterX, towardCenterY) || 1
        const hbx = towardCenterX / towardCenterLen
        const hby = towardCenterY / towardCenterLen
        flapList.push({
          key: node.id,
          center: childPos,
          radius: width,
          points: toPointsAttr(octagon, VIEW_SIZE),
          handle: { x: childPos.x + width * hbx, y: childPos.y + width * hby },
          color: colorForConstraint(node.id, constraints.perLeaf[node.id]),
        })
      } else {
        const river = riverPolygon(parentPos, childPos, width)
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
          points: toPointsAttr(river, VIEW_SIZE),
          handle: { x: mx + (nx * width) / 2, y: my + (ny * width) / 2 },
        })
      }
    }
    return { flaps: flapList, rivers: riverList }
  }, [tree, packing, constraints])

  const overlaps = useMemo(() => {
    if (!packing) return []
    return findAllOverlaps(tree, packing.positions, packing.scale)
  }, [tree, packing])

  return (
    <div className="packing-editor-wrapper">
      <svg
        ref={svgRef}
        className="packing-editor-canvas"
        viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <rect className="packing-square" x={0} y={0} width={VIEW_SIZE} height={VIEW_SIZE} />

        {constraints.symmetryMode === 'book' && (
          <line className="symmetry-line" x1={VIEW_SIZE / 2} y1={0} x2={VIEW_SIZE / 2} y2={VIEW_SIZE} />
        )}
        {constraints.symmetryMode === 'diagonal' && (
          <line className="symmetry-line" x1={0} y1={0} x2={VIEW_SIZE} y2={VIEW_SIZE} />
        )}

        {rivers.map((r) => (
          <g key={`river-${r.key}`}>
            <polygon
              className="packing-river"
              points={r.points}
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
              className={'packing-flap' + (f.key === selectedFlapId ? ' selected' : '')}
              style={{ stroke: f.color, fill: `${f.color}26` }}
              points={f.points}
              onPointerDown={(e) => beginMoveFlap(f.key, e)}
            />
            <circle
              className="flap-handle"
              style={{ stroke: f.color }}
              cx={f.handle.x * VIEW_SIZE}
              cy={f.handle.y * VIEW_SIZE}
              r={5}
              onPointerDown={(e) => beginResizeFlap(f.key, f.center, e)}
            />
          </g>
        ))}

        {selectedFlapId &&
          EDGE_HANDLES.map((h) => (
            <rect
              key={`edge-handle-${h.edge}`}
              className="pin-handle"
              x={h.x * VIEW_SIZE - 6}
              y={h.y * VIEW_SIZE - 6}
              width={12}
              height={12}
              onClick={() => pinToEdge(selectedFlapId, h.edge)}
            />
          ))}

        {selectedFlapId &&
          CORNER_HANDLES.map((h) => (
            <rect
              key={`corner-handle-${h.corner}`}
              className="pin-handle pin-handle-corner"
              x={h.x * VIEW_SIZE - 7}
              y={h.y * VIEW_SIZE - 7}
              width={14}
              height={14}
              transform={`rotate(45 ${h.x * VIEW_SIZE} ${h.y * VIEW_SIZE})`}
              onClick={() => pinToCorner(selectedFlapId, h.corner)}
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
      <ConstraintPanel />
    </div>
  )
}
