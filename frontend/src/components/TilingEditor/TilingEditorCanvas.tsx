import { useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useAppStore } from '../../state/store'
import { buildShapePoints, extraRotationFor } from '../../geometry/shapes'
import { computeRiverBands, ringsToPathD } from '../../geometry/rivers'
import { useViewBoxPanZoom } from '../../hooks/useViewBoxPanZoom'
import { VIEW_SIZE } from '../PackingEditor/usePackingEditorInteraction'
import './TilingEditor.css'

/** The unit square is y-up internally (see geometry/edgePin.ts); flip y so
 * it renders right-side up in screen space -- same convention as
 * PackingEditorCanvas.tsx. */
function toPointsAttr(points: [number, number][], scale: number): string {
  return points.map(([x, y]) => `${x * scale},${(1 - y) * scale}`).join(' ')
}

function toScreen(x: number, y: number): [number, number] {
  return [x * VIEW_SIZE, (1 - y) * VIEW_SIZE]
}

interface FlapInfo {
  key: string
  points: string
}

interface RiverInfo {
  key: string
  pathD: string
}

/** View-only: pans/zooms like the other two canvases but has no click/drag
 * interactions of its own. Renders the same flap/river geometry as the
 * packing canvas, but only draws the paths that were actually selected by
 * the last path-network snap solve -- direct paths as a straight line
 * between the two flaps, half-legs as a straight line from a flap to its
 * intermediate point. */
export function TilingEditorCanvas() {
  const svgRef = useRef<SVGSVGElement>(null)
  const tree = useAppStore((s) => s.tree)
  const packing = useAppStore((s) => s.packing)
  const shape = useAppStore((s) => s.hyperparams.shape)
  const hexagonExtraRotation = useAppStore((s) => s.hyperparams.hexagonExtraRotation)
  const squareExtraRotation = useAppStore((s) => s.hyperparams.squareExtraRotation)
  const dodecagonExtraRotation = useAppStore((s) => s.hyperparams.dodecagonExtraRotation)
  const extraRotation = extraRotationFor(shape, hexagonExtraRotation, squareExtraRotation, dodecagonExtraRotation)
  const constraints = useAppStore((s) => s.constraints)
  const pathNetworkResult = useAppStore((s) => s.pathNetworkResult)
  const pan = useViewBoxPanZoom(svgRef, { x: 0, y: 0, w: VIEW_SIZE, h: VIEW_SIZE })

  const onBackgroundPointerDown = (e: ReactPointerEvent<SVGRectElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // best-effort
    }
    pan.beginPan(e)
  }
  const onSvgPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => pan.onPanMove(e)
  const onSvgPointerUp = () => pan.endPan()

  const { flaps, rivers } = useMemo(() => {
    const flapList: FlapInfo[] = []
    const riverList: RiverInfo[] = []
    if (!packing) return { flaps: flapList, rivers: riverList }

    const bands = computeRiverBands(tree, packing.positions, packing.scale, shape, constraints.symmetryMode, extraRotation)
    const pathByNodeId = new Map(bands.map((b) => [b.nodeId, ringsToPathD(b.rings, VIEW_SIZE)]))

    for (const node of Object.values(tree.nodes)) {
      if (!node.parentId || node.length == null) continue
      const childPos = packing.positions[node.id]
      if (!childPos) continue

      const width = packing.scale * node.length
      if (node.children.length === 0) {
        const shapePoints = buildShapePoints(shape, childPos.x, childPos.y, width, constraints.symmetryMode, extraRotation)
        flapList.push({ key: node.id, points: toPointsAttr(shapePoints, VIEW_SIZE) })
      } else {
        const pathD = pathByNodeId.get(node.id)
        if (pathD == null) continue
        riverList.push({ key: node.id, pathD })
      }
    }
    return { flaps: flapList, rivers: riverList }
  }, [tree, packing, constraints, shape, extraRotation])

  return (
    <div className="tiling-editor-wrapper">
      <svg
        ref={svgRef}
        className="tiling-editor-canvas"
        viewBox={pan.viewBoxAttr}
        onPointerMove={onSvgPointerMove}
        onPointerUp={onSvgPointerUp}
        onPointerLeave={onSvgPointerUp}
      >
        <rect
          className="tiling-editor-backdrop"
          x={pan.viewBox.x}
          y={pan.viewBox.y}
          width={pan.viewBox.w}
          height={pan.viewBox.h}
          onPointerDown={onBackgroundPointerDown}
        />
        <rect className="tiling-square" x={0} y={0} width={VIEW_SIZE} height={VIEW_SIZE} onPointerDown={onBackgroundPointerDown} />

        {rivers.map((r) => (
          <path key={`tiling-river-${r.key}`} className="tiling-river" fillRule="evenodd" d={r.pathD} />
        ))}
        {flaps.map((f) => (
          <polygon key={`tiling-flap-${f.key}`} className="tiling-flap" points={f.points} />
        ))}

        {packing &&
          pathNetworkResult?.selectedDirectPaths.map((p) => {
            const pa = packing.positions[p.a]
            const pb = packing.positions[p.b]
            if (!pa || !pb) return null
            const [x1, y1] = toScreen(pa.x, pa.y)
            const [x2, y2] = toScreen(pb.x, pb.y)
            return <line key={`tiling-direct-${p.a}-${p.b}`} className="tiling-selected-path" x1={x1} y1={y1} x2={x2} y2={y2} />
          })}
        {packing &&
          pathNetworkResult?.selectedLegs.map((leg, i) => {
            const pf = packing.positions[leg.flap]
            if (!pf) return null
            const [x1, y1] = toScreen(pf.x, pf.y)
            const [x2, y2] = toScreen(leg.x, leg.y)
            return <line key={`tiling-leg-${leg.flap}-${i}`} className="tiling-selected-path" x1={x1} y1={y1} x2={x2} y2={y2} />
          })}
      </svg>
      {!pathNetworkResult && <div className="tiling-empty-hint">Run "Snap path network" to populate this view</div>}
    </div>
  )
}
