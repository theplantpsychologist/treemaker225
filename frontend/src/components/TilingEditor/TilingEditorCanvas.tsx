import { useEffect, useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useAppStore } from '../../state/store'
import { buildShapePoints, extraRotationFor } from '../../geometry/shapes'
import { computeRiverBands, ringsToPathD } from '../../geometry/rivers'
import { computeFaces } from '../../geometry/planarFaces'
import { computeHinges, computeStraightSkeleton } from '../../geometry/straightSkeleton'
import { signatureOf } from '../../geometry/tilingCotangent'
import { useViewBoxPanZoom } from '../../hooks/useViewBoxPanZoom'
import { VIEW_SIZE } from '../PackingEditor/usePackingEditorInteraction'
import { useTilingEditorInteraction } from './useTilingEditorInteraction'
import { TilingInspector } from './TilingInspector'
import type { TilingGraphState } from '../../types/tilingGraph'
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

/** Flap positions from the tiling graph, layered over `packing.positions` --
 * `computeRiverBands` recurses top-down from the tree root and bails out
 * entirely (returning zero bands) if *any* node along the way, including
 * root and every internal/river node, has no entry in `positions` at all
 * (see `geometry/rivers.ts`'s `computeNode`) -- even though an internal
 * node's own (x, y) value is never actually read for anything, only its
 * presence is checked. The tiling graph itself has no notion of internal
 * tree nodes at all (only flap and intermediate-crease vertices), so a
 * flap-only position map used alone silently produced zero rivers. Falling
 * back to the (unchanging, pre-seed) packing position for every node this
 * graph doesn't cover keeps every entry present while still reflecting each
 * flap's *current* (possibly since-dragged) tiling position. */
function riverPositionsFromGraph(
  graph: TilingGraphState,
  packingPositions: Record<string, { x: number; y: number }>,
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = { ...packingPositions }
  for (const v of Object.values(graph.vertices)) {
    if (v.kind === 'flap' && v.flapId) out[v.flapId] = { x: v.x, y: v.y }
  }
  return out
}

const FREE_AXIS_TICK = 8

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
  const clipToSquare = useAppStore((s) => s.clipToSquare)
  const tilingGraph = useAppStore((s) => s.tilingGraph)
  const tilingSelectedVertexIds = useAppStore((s) => s.tilingSelectedVertexIds)
  const tilingSelectedLegId = useAppStore((s) => s.tilingSelectedLegId)
  const tilingPathCandidates = useAppStore((s) => s.tilingPathCandidates)
  const tilingSkeletonSelection = useAppStore((s) => s.tilingSkeletonSelection)
  const clearTilingSelection = useAppStore((s) => s.clearTilingSelection)
  const deleteSelectedTilingLeg = useAppStore((s) => s.deleteSelectedTilingLeg)
  const deleteSelectedTilingVertex = useAppStore((s) => s.deleteSelectedTilingVertex)
  const chooseTilingPathOption = useAppStore((s) => s.chooseTilingPathOption)
  const selectTilingSkeletonVertex = useAppStore((s) => s.selectTilingSkeletonVertex)
  const selectTilingSkeletonRidge = useAppStore((s) => s.selectTilingSkeletonRidge)
  const pruneStaleTilingSkeletonLocks = useAppStore((s) => s.pruneStaleTilingSkeletonLocks)
  const pan = useViewBoxPanZoom(svgRef, { x: 0, y: 0, w: VIEW_SIZE, h: VIEW_SIZE })
  const { beginVertexPointerDown, onLegPointerDown, onPointerMove, onPointerUp } = useTilingEditorInteraction(svgRef)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isTyping = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      if (isTyping) return
      if (e.key === 'Escape') {
        clearTilingSelection()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (tilingSelectedLegId) deleteSelectedTilingLeg()
        else if (tilingSelectedVertexIds.length === 1) deleteSelectedTilingVertex()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [clearTilingSelection, tilingSelectedLegId, deleteSelectedTilingLeg, tilingSelectedVertexIds, deleteSelectedTilingVertex])

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
      clearTilingSelection()
    }
  }

  const { flaps, rivers } = useMemo(() => {
    const flapList: FlapInfo[] = []
    const riverList: RiverInfo[] = []
    if (!packing) return { flaps: flapList, rivers: riverList }
    const positions = tilingGraph ? riverPositionsFromGraph(tilingGraph, packing.positions) : packing.positions

    const bands = computeRiverBands(tree, positions, packing.scale, shape, constraints.symmetryMode, extraRotation)
    const pathByNodeId = new Map(bands.map((b) => [b.nodeId, ringsToPathD(b.rings, VIEW_SIZE)]))

    for (const node of Object.values(tree.nodes)) {
      if (!node.parentId || node.length == null) continue

      if (node.children.length === 0) {
        // Only flap (leaf) nodes need their own position here -- `positions`
        // is flap-only once a tilingGraph exists (it has no entry for
        // internal/river nodes at all, unlike `packing.positions`, which
        // covers every tree node). River bands never need an internal
        // node's own position anyway (see `computeRiverBands`'s doc): its
        // band shape is derived purely from its children's footprints.
        const childPos = positions[node.id]
        if (!childPos) continue
        const width = packing.scale * node.length
        const shapePoints = buildShapePoints(shape, childPos.x, childPos.y, width, constraints.symmetryMode, extraRotation)
        flapList.push({ key: node.id, points: toPointsAttr(shapePoints, VIEW_SIZE) })
      } else {
        const pathD = pathByNodeId.get(node.id)
        if (pathD == null) continue
        riverList.push({ key: node.id, pathD })
      }
    }
    return { flaps: flapList, rivers: riverList }
  }, [tree, packing, tilingGraph, constraints, shape, extraRotation])

  // Topology only -- recomputes when a path is created or deleted, not on
  // every drag frame. `tilingGraph.legs` is a stable reference across a
  // drag (the store only spreads `vertices` on drag, see
  // `state/store.ts`'s `dragTilingVertex`-style action), so this
  // useMemo's dependency correctly gates on topology changes alone.
  const faces = useMemo(() => {
    if (!tilingGraph) return []
    return computeFaces(tilingGraph.vertices, Object.values(tilingGraph.legs))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilingGraph?.legs])

  // Geometry -- recomputes every render (including every drag frame) since
  // it depends on live vertex positions, not just topology. `legIdByEdgeIndex`
  // maps each of `computeStraightSkeleton`'s internal `edges[i]` (always
  // `face.vertexIds[i] -> face.vertexIds[i+1]`) back to the real leg
  // connecting that pair -- always exists, since a face's boundary edges are
  // always real legs -- giving every skeleton node/ridge a stable identity
  // (its constituent legs' ids) independent of this per-call array index.
  const skeletons = useMemo(() => {
    if (!tilingGraph) return []
    return faces
      .map((face) => {
        const polygon = face.vertexIds.map((id) => tilingGraph.vertices[id])
        const skeleton = computeStraightSkeleton(polygon)
        if (!skeleton) return null
        const n = face.vertexIds.length
        const legIdByEdgeIndex = face.vertexIds.map((a, i) => {
          const b = face.vertexIds[(i + 1) % n]
          return Object.values(tilingGraph.legs).find((l) => (l.vertexA === a && l.vertexB === b) || (l.vertexA === b && l.vertexB === a))?.id
        })
        return { faceId: face.id, skeleton, hinges: computeHinges(skeleton.nodes, skeleton.edges), legIdByEdgeIndex }
      })
      .filter(
        (
          s,
        ): s is {
          faceId: string
          skeleton: NonNullable<ReturnType<typeof computeStraightSkeleton>>
          hinges: ReturnType<typeof computeHinges>
          legIdByEdgeIndex: (string | undefined)[]
        } => s !== null,
      )
  }, [faces, tilingGraph])

  // Nodes' `legIds` (via `legIdByEdgeIndex`) -- computed once per skeletons
  // recompute, reused by both the stale-lock-release effect below and the
  // dot/ring rendering further down. A node whose `tangentEdges` fail to
  // fully resolve to real leg ids (shouldn't happen -- every face boundary
  // edge is always a real leg -- but degrades safely rather than silently
  // under-counting) is dropped rather than shown with a wrong edge count.
  const skeletonNodesWithLegIds = useMemo(
    () =>
      skeletons.map(({ faceId, skeleton, legIdByEdgeIndex }) => ({
        faceId,
        skeleton,
        nodes: skeleton.nodes
          .map((node) => ({ node, legIds: node.tangentEdges.map((i) => legIdByEdgeIndex[i]) }))
          .filter((n): n is { node: (typeof skeleton.nodes)[number]; legIds: string[] } => n.legIds.every((id) => id != null)),
      })),
    [skeletons],
  )

  // Reactive release of any lock whose live geometry has broken (the
  // straight skeleton no longer produces a node with exactly this
  // tangent-edge set) -- see `pruneStaleSkeletonLocks`'s doc. Runs after
  // every recompute of the live skeleton, including drag frames; the store
  // action itself no-ops (no `set()`) when nothing actually changed.
  useEffect(() => {
    if (!tilingGraph || tilingGraph.skeletonLocks.length === 0) return
    const live = new Set(
      skeletonNodesWithLegIds.flatMap(({ nodes }) => nodes.map(({ legIds }) => signatureOf(legIds))),
    )
    pruneStaleTilingSkeletonLocks(live)
  }, [skeletonNodesWithLegIds, tilingGraph, pruneStaleTilingSkeletonLocks])

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
        <defs>
          <clipPath id="tiling-square-clip">
            <rect x={0} y={0} width={VIEW_SIZE} height={VIEW_SIZE} />
          </clipPath>
        </defs>
        <rect
          className="tiling-editor-backdrop"
          x={pan.viewBox.x}
          y={pan.viewBox.y}
          width={pan.viewBox.w}
          height={pan.viewBox.h}
          onPointerDown={onBackgroundPointerDown}
        />
        <rect className="tiling-square" x={0} y={0} width={VIEW_SIZE} height={VIEW_SIZE} onPointerDown={onBackgroundPointerDown} />

        <g clipPath={clipToSquare ? 'url(#tiling-square-clip)' : undefined}>
          {rivers.map((r) => (
            <path key={`tiling-river-${r.key}`} className="tiling-river" fillRule="evenodd" d={r.pathD} />
          ))}
          {flaps.map((f) => (
            <polygon key={`tiling-flap-${f.key}`} className="tiling-flap" points={f.points} />
          ))}

          {skeletonNodesWithLegIds.flatMap(({ faceId, skeleton, nodes }) =>
            skeleton.ridges.map((r, i) => {
              const [x1, y1] = toScreen(r.start.x, r.start.y)
              const [x2, y2] = toScreen(r.end.x, r.end.y)
              const className = `tiling-ridge${r.isReflexBoundary ? ' concave' : ''}`
              // An "interior" ridge (both endpoints interior straight-skeleton
              // nodes, not the original polygon boundary) is clickable --
              // resolve each endpoint to its owning node's legIds by position
              // match, then offer the same invisible-wide-hit-line technique
              // already used for path-preview lines.
              if (!r.startIsBoundary && !r.endIsBoundary) {
                const nodeAt = (p: { x: number; y: number }) =>
                  nodes.find(({ node }) => Math.hypot(node.position.x - p.x, node.position.y - p.y) < 1e-6)
                const startNode = nodeAt(r.start)
                const endNode = nodeAt(r.end)
                if (startNode && endNode && startNode.legIds.length >= 3 && endNode.legIds.length >= 3) {
                  const isSelected =
                    tilingSkeletonSelection?.kind === 'ridge' &&
                    ((signatureOf(tilingSkeletonSelection.legIdsA) === signatureOf(startNode.legIds) &&
                      signatureOf(tilingSkeletonSelection.legIdsB) === signatureOf(endNode.legIds)) ||
                      (signatureOf(tilingSkeletonSelection.legIdsA) === signatureOf(endNode.legIds) &&
                        signatureOf(tilingSkeletonSelection.legIdsB) === signatureOf(startNode.legIds)))
                  return (
                    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
                    <g
                      key={`tiling-ridge-${faceId}-${i}`}
                      onClick={() => selectTilingSkeletonRidge(startNode.legIds, endNode.legIds)}
                    >
                      <line className="tiling-skeleton-ridge-hit" x1={x1} y1={y1} x2={x2} y2={y2} />
                      <line className={`${className}${isSelected ? ' selected' : ''}`} x1={x1} y1={y1} x2={x2} y2={y2} />
                    </g>
                  )
                }
              }
              return <line key={`tiling-ridge-${faceId}-${i}`} className={className} x1={x1} y1={y1} x2={x2} y2={y2} />
            }),
          )}
          {skeletons.flatMap(({ faceId, hinges }) =>
            hinges.map((h, i) => {
              const [x1, y1] = toScreen(h.from.x, h.from.y)
              const [x2, y2] = toScreen(h.to.x, h.to.y)
              return <line key={`tiling-hinge-${faceId}-${i}`} className="tiling-hinge" x1={x1} y1={y1} x2={x2} y2={y2} />
            }),
          )}
        </g>

        {tilingGraph &&
          Object.values(tilingGraph.legs).map((leg) => {
            const pa = tilingGraph.vertices[leg.vertexA]
            const pb = tilingGraph.vertices[leg.vertexB]
            if (!pa || !pb) return null
            const [x1, y1] = toScreen(pa.x, pa.y)
            const [x2, y2] = toScreen(pb.x, pb.y)
            const selected = leg.id === tilingSelectedLegId
            return (
              <line
                key={`tiling-leg-${leg.id}`}
                className={`tiling-leg${selected ? ' selected' : ''}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                onPointerDown={(e) => onLegPointerDown(leg.id, e)}
              />
            )
          })}

        {tilingPathCandidates &&
          tilingGraph &&
          tilingPathCandidates.options.map((option, i) => {
            const pa = tilingGraph.vertices[tilingPathCandidates.vertexAId]
            const pb = tilingGraph.vertices[tilingPathCandidates.vertexBId]
            if (!pa || !pb) return null
            const [ax, ay] = toScreen(pa.x, pa.y)
            const [bx, by] = toScreen(pb.x, pb.y)
            if (option.kind === 'direct') {
              return (
                // eslint-disable-next-line jsx-a11y/no-static-element-interactions
                <g key={`tiling-path-option-${i}`} className="tiling-bend-preview" onClick={() => chooseTilingPathOption(i)}>
                  <line className="tiling-bend-preview-hit" x1={ax} y1={ay} x2={bx} y2={by} />
                  <line x1={ax} y1={ay} x2={bx} y2={by} />
                </g>
              )
            }
            const [px, py] = toScreen(option.config.bendPoint.x, option.config.bendPoint.y)
            return (
              // eslint-disable-next-line jsx-a11y/no-static-element-interactions
              <g key={`tiling-path-option-${i}`} className="tiling-bend-preview" onClick={() => chooseTilingPathOption(i)}>
                <line className="tiling-bend-preview-hit" x1={ax} y1={ay} x2={px} y2={py} />
                <line className="tiling-bend-preview-hit" x1={bx} y1={by} x2={px} y2={py} />
                <line x1={ax} y1={ay} x2={px} y2={py} />
                <line x1={bx} y1={by} x2={px} y2={py} />
                <circle cx={px} cy={py} r={5} />
              </g>
            )
          })}

        {tilingGraph &&
          Object.values(tilingGraph.vertices).map((v) => {
            const [x, y] = toScreen(v.x, v.y)
            const selected = tilingSelectedVertexIds.includes(v.id)
            const free = tilingGraph.freeAxes[v.id]
            return (
              <g key={`tiling-vertex-${v.id}`}>
                <circle
                  className={`tiling-vertex-dot ${v.kind}${selected ? ' armed' : ''}`}
                  cx={x}
                  cy={y}
                  r={v.kind === 'flap' ? 5 : 3}
                  onPointerDown={(e) => beginVertexPointerDown(v.id, e)}
                />
                {free?.x && <line className="tiling-free-axis-mark" x1={x - FREE_AXIS_TICK} y1={y} x2={x + FREE_AXIS_TICK} y2={y} />}
                {free?.y && <line className="tiling-free-axis-mark" x1={x} y1={y - FREE_AXIS_TICK} x2={x} y2={y + FREE_AXIS_TICK} />}
              </g>
            )
          })}

        {tilingGraph &&
          skeletonNodesWithLegIds.flatMap(({ faceId, nodes }) =>
            nodes.map(({ node, legIds }, i) => {
              const sig = signatureOf(legIds)
              const locked = tilingGraph.skeletonLocks.some((l) => signatureOf(l.legIds) === sig)
              const selected = tilingSkeletonSelection?.kind === 'vertex' && signatureOf(tilingSkeletonSelection.legIds) === sig
              const [x, y] = toScreen(node.position.x, node.position.y)
              return (
                <g key={`tiling-skeleton-vertex-${faceId}-${i}`}>
                  {locked && <circle className="tiling-skeleton-lock-ring" cx={x} cy={y} r={7} />}
                  <circle
                    className={`tiling-skeleton-vertex-dot${selected ? ' armed' : ''}`}
                    cx={x}
                    cy={y}
                    r={4}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      selectTilingSkeletonVertex(legIds)
                    }}
                  />
                </g>
              )
            }),
          )}
      </svg>
      {tilingGraph ? (
        <div className="tiling-dof-readout">Degrees of freedom: {tilingGraph.dof}</div>
      ) : (
        <div className="tiling-empty-hint">Click "Seed tiling" to populate this view</div>
      )}
      <TilingInspector />
    </div>
  )
}
