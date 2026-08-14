import { useEffect, useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useAppStore } from '../../state/store'
import { buildShapePoints, extraRotationFor } from '../../geometry/shapes'
import { computeRiverBands, ringsToPathD } from '../../geometry/rivers'
import { computeFaces } from '../../geometry/planarFaces'
import { computeStraightSkeleton } from '../../geometry/straightSkeleton'
import { signatureOf } from '../../geometry/tilingCotangent'
import { prepareMirrors } from '../../geometry/hingeRayCast'
import type { MirrorSegment } from '../../geometry/hingeRayCast'
import { computeHingeChains, crossingKey } from '../../geometry/hingeChains'
import { DEFAULT_INITIAL_ZOOM_OUT_FACTOR, paddedInitialViewBox, useViewBoxPanZoom } from '../../hooks/useViewBoxPanZoom'
import { VIEW_SIZE } from '../PackingEditor/usePackingEditorInteraction'
import {
  TILING_FLAP_VERTEX_RADIUS_PX,
  TILING_INTERMEDIATE_VERTEX_RADIUS_PX,
  TILING_SKELETON_LOCK_RING_RADIUS_PX,
  TILING_SKELETON_VERTEX_RADIUS_PX,
} from '../../constants/sizeTokens'
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

/** The physical paper's edge, in the same unit-square coordinates as every
 * tiling vertex/skeleton position -- a hinge ray reaching one of these
 * segments has run off the paper and stops there (see `castHingeRay`). */
const UNIT_SQUARE_BOUNDARY_SEGMENTS: MirrorSegment[] = [
  { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
  { a: { x: 1, y: 0 }, b: { x: 1, y: 1 } },
  { a: { x: 1, y: 1 }, b: { x: 0, y: 1 } },
  { a: { x: 0, y: 1 }, b: { x: 0, y: 0 } },
]
// Prepared once at module scope, not per render -- these 4 segments never
// change (see `prepareMirrors`'s doc).
const UNIT_SQUARE_BOUNDARY = prepareMirrors(UNIT_SQUARE_BOUNDARY_SEGMENTS)

interface FlapInfo {
  key: string
  points: string
  /** True once a tiling graph exists and this flap's vertex has fewer than
   * 2 incident legs -- a flap needs at least 2 paths to be structurally
   * meaningful (one path alone can't form a crease network around it), so
   * this flags it in the Inspector-free-canvas the same way `.tiling-flap`
   * itself flags selection elsewhere in this file. */
  understaffed: boolean
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

/** Free-axis tick half-length, as a multiple of the vertex dot's own
 * on-screen radius -- rather than a flat pixel constant, so the "+" reads
 * consistently sized relative to the dot it passes through regardless of
 * zoom level or which vertex kind (flap vs. intermediate) it's drawn on. */
const FREE_AXIS_TICK_FACTOR = 1.8

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
  const showTilingFlapsAndRivers = useAppStore((s) => s.showTilingFlapsAndRivers)
  const showTilingHinges = useAppStore((s) => s.showTilingHinges)
  const tilingMinFeatureSize = useAppStore((s) => s.hyperparams.tilingMinFeatureSize)
  const tilingMaxHingeBounces = useAppStore((s) => s.hyperparams.tilingMaxHingeBounces)
  const tilingGraph = useAppStore((s) => s.tilingGraph)
  const tilingSelectedVertexIds = useAppStore((s) => s.tilingSelectedVertexIds)
  const tilingSelectedLegId = useAppStore((s) => s.tilingSelectedLegId)
  const tilingPathCandidates = useAppStore((s) => s.tilingPathCandidates)
  const tilingSkeletonSelection = useAppStore((s) => s.tilingSkeletonSelection)
  const tilingSelectedChainIds = useAppStore((s) => s.tilingSelectedChainIds)
  const selectTilingHingeChain = useAppStore((s) => s.selectTilingHingeChain)
  const attemptHingeChainLock = useAppStore((s) => s.attemptHingeChainLock)
  const tilingSelectedHingeChainLock = useAppStore((s) => s.tilingSelectedHingeChainLock)
  const selectTilingHingeChainLock = useAppStore((s) => s.selectTilingHingeChainLock)
  const clearTilingSelection = useAppStore((s) => s.clearTilingSelection)
  const deleteSelectedTilingLeg = useAppStore((s) => s.deleteSelectedTilingLeg)
  const deleteSelectedTilingVertex = useAppStore((s) => s.deleteSelectedTilingVertex)
  const chooseTilingPathOption = useAppStore((s) => s.chooseTilingPathOption)
  const selectTilingSkeletonVertex = useAppStore((s) => s.selectTilingSkeletonVertex)
  const selectTilingSkeletonRidge = useAppStore((s) => s.selectTilingSkeletonRidge)
  const pruneStaleTilingSkeletonLocks = useAppStore((s) => s.pruneStaleTilingSkeletonLocks)
  const pan = useViewBoxPanZoom(svgRef, paddedInitialViewBox(VIEW_SIZE, DEFAULT_INITIAL_ZOOM_OUT_FACTOR))
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

    // Built once (O(V) + O(L)) instead of re-scanning every vertex/leg per
    // leaf node below (which was O((V+L) * leaves) overall) -- same
    // understaffed-count result either way, since a flap vertex's id and
    // leg-degree don't change within this single computation.
    const flapVertexByFlapId = new Map<string, { id: string }>()
    const legCountByVertexId = new Map<string, number>()
    if (tilingGraph) {
      for (const v of Object.values(tilingGraph.vertices)) {
        if (v.kind === 'flap' && v.flapId) flapVertexByFlapId.set(v.flapId, v)
      }
      for (const leg of Object.values(tilingGraph.legs)) {
        legCountByVertexId.set(leg.vertexA, (legCountByVertexId.get(leg.vertexA) ?? 0) + 1)
        legCountByVertexId.set(leg.vertexB, (legCountByVertexId.get(leg.vertexB) ?? 0) + 1)
      }
    }

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
        // A flap needs at least 2 legs (paths) incident to its vertex to be
        // structurally meaningful -- undefined (no tiling graph yet, or this
        // leaf's flap vertex isn't in it for some other reason) never counts
        // as understaffed, only a real, too-low leg count does.
        const flapVertex = flapVertexByFlapId.get(node.id)
        const legCount = flapVertex ? (legCountByVertexId.get(flapVertex.id) ?? 0) : null
        flapList.push({
          key: node.id,
          points: toPointsAttr(shapePoints, VIEW_SIZE),
          understaffed: legCount !== null && legCount < 2,
        })
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

  // Topology only, same reasoning as `faces` above -- a vertex-pair -> leg
  // id lookup never depends on live positions, so it's memoized separately
  // from `skeletons` below (which DOES need to rerun every drag frame for
  // the position-dependent skeleton itself). Without this, `skeletons`
  // used to redo an O(legs) `.find()` per face edge on every single drag
  // frame even though its result couldn't have changed since the last
  // topology edit.
  const legIdByVertexPair = useMemo(() => {
    const map = new Map<string, string>()
    if (!tilingGraph) return map
    for (const leg of Object.values(tilingGraph.legs)) {
      map.set(`${leg.vertexA}|${leg.vertexB}`, leg.id)
      map.set(`${leg.vertexB}|${leg.vertexA}`, leg.id)
    }
    return map
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
          return legIdByVertexPair.get(`${a}|${b}`)
        })
        return { faceId: face.id, skeleton, legIdByEdgeIndex }
      })
      .filter(
        (
          s,
        ): s is {
          faceId: string
          skeleton: NonNullable<ReturnType<typeof computeStraightSkeleton>>
          legIdByEdgeIndex: (string | undefined)[]
        } => s !== null,
      )
  }, [faces, tilingGraph, legIdByVertexPair])

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

  // Every hinge grouped into a selectable chain -- see
  // `geometry/hingeChains.ts`'s module doc. Mirror candidates are global
  // (every face's ridges, not just the hinge's own face) since a hinge's
  // path can cross into a neighboring face's territory; recomputed every
  // render alongside `skeletons`/`skeletonNodesWithLegIds` since all three
  // depend on live positions -- this keeps hinges visually live while
  // dragging a vertex, with no store write (no persisted state depends on
  // this per-render recompute; see `useTilingEditorInteraction.ts`'s
  // `onPointerUp` for what settles only on mouseup).
  const hingeChains = useMemo(() => {
    if (!tilingGraph) return []
    const legMirrors: MirrorSegment[] = []
    const legIdByMirrorIndex: string[] = []
    for (const leg of Object.values(tilingGraph.legs)) {
      const a = tilingGraph.vertices[leg.vertexA]
      const b = tilingGraph.vertices[leg.vertexB]
      if (a && b) {
        legMirrors.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } })
        legIdByMirrorIndex.push(leg.id)
      }
    }
    const ridgeMirrors: MirrorSegment[] = skeletons.flatMap(({ skeleton }) =>
      skeleton.ridges.map((r) => ({ a: r.start, b: r.end })),
    )
    const tilingVertices = Object.values(tilingGraph.vertices).map((v) => ({ id: v.id, x: v.x, y: v.y }))
    return computeHingeChains(
      skeletonNodesWithLegIds,
      prepareMirrors(legMirrors),
      legIdByMirrorIndex,
      prepareMirrors(ridgeMirrors),
      UNIT_SQUARE_BOUNDARY,
      tilingVertices,
      tilingMinFeatureSize,
      tilingMaxHingeBounces,
    )
  }, [skeletons, skeletonNodesWithLegIds, tilingGraph, tilingMinFeatureSize, tilingMaxHingeBounces])

  // The moment `tilingSelectedChainIds` reaches 2 ids that both resolve to
  // a live chain, attempt the chain-collinearity lock -- this is the only
  // place with the actual `HingeChain` objects (`hingeChains` is a plain
  // per-render memo, never stored, see that useMemo's own doc), so the
  // store's `selectTilingHingeChain` can't do this itself despite owning
  // the selection. `attemptHingeChainLock` always clears the selection
  // (success or error), which is exactly this effect's own re-run guard --
  // it naturally stops firing after one attempt per 2-selection, not once
  // per render while 2 stay selected.
  useEffect(() => {
    if (tilingSelectedChainIds.length !== 2) return
    const [chainA, chainB] = tilingSelectedChainIds.map((id) => hingeChains.find((c) => c.id === id))
    if (!chainA || !chainB) return
    attemptHingeChainLock(chainA, chainB)
  }, [tilingSelectedChainIds, hingeChains, attemptHingeChainLock])

  // The fused polyline for every committed `HingeChainLock` whose both
  // sides still resolve against the live `hingeChains`. `points` normally
  // runs source A -> ... -> the (now shared) point on the common leg -> ...
  // -> source B, EXCEPT when the two sources ended up close enough that one
  // side's hinge now terminates directly at the other's source instead of
  // independently reaching the common leg (see `tilingGraphActions.ts`'s
  // `chainReachesCommonLeg` for the same case handled on the constraint
  // side) -- a real, intended outcome (the two chains fuse into one
  // continuous crease between the sources), not a broken match.
  const lockedConnectors = useMemo(() => {
    if (!tilingGraph) return []
    const out: { lock: (typeof tilingGraph.hingeChainLocks)[number]; points: { x: number; y: number }[] }[] = []
    for (const lock of tilingGraph.hingeChainLocks) {
      const sigA = signatureOf(lock.a.sourceLegIds)
      const sigB = signatureOf(lock.b.sourceLegIds)
      const commonLegIdx = (c: (typeof hingeChains)[number]) =>
        c.crossings.findIndex((cr) => cr.anchor.kind === 'leg' && cr.anchor.legId === lock.commonLegId)

      // Resolves one lock side to `{ chain, points, reachesCommonLeg }` --
      // `points` always starts at this side's own source and either ends at
      // the shared common-leg point (`reachesCommonLeg: true`) or directly
      // at the OTHER side's source (`false`, the coalesced case).
      const resolveSide = (side: typeof lock.a, otherSig: string) => {
        // Matched by source signature AND `tangentLegId` -- signature alone
        // isn't enough, since one source can have several tangent
        // directions (a real bug: an earlier version matched whichever
        // same-signature chain happened to satisfy the crossing/coalesce
        // check first, occasionally picking a completely different hinge
        // than the one this lock side actually refers to).
        const direct = hingeChains.find((c) => c.tangentLegId === side.tangentLegId && signatureOf(c.sourceLegIds) === signatureOf(side.sourceLegIds))
        if (direct) {
          const idx = commonLegIdx(direct)
          if (idx !== -1) {
            // Inclusive of `idx` -- the persisted side's own `crossings`
            // includes the common-leg crossing itself (see
            // `tilingGraphActions.ts`'s `sideLock`'s doc for why it must,
            // otherwise `hingeChainLock.ts`'s `walkToCommonLeg` can never
            // find it again on a later re-derivation).
            const liveKeys = direct.crossings.slice(0, idx + 1).map((cr) => crossingKey(cr.anchor))
            const storedKeys = side.crossings.map((cr) => crossingKey(cr.anchor))
            if (liveKeys.length === storedKeys.length && liveKeys.every((k, i) => k === storedKeys[i])) {
              const common = direct.crossings[idx]
              const iP = direct.points.findIndex((p) => p.x === common.point.x && p.y === common.point.y)
              if (iP !== -1) return { chain: direct, points: direct.points.slice(0, iP + 1), reachesCommonLeg: true }
            }
          }
          if (direct.termination.kind === 'skeletonVertex' && signatureOf(direct.termination.legIds) === otherSig) {
            return { chain: direct, points: direct.points, reachesCommonLeg: false }
          }
        }
        // This side's own specific hinge may have been deduped away as an
        // exact mutual retrace of some OTHER (structurally unrelated)
        // hinge from the opposite source -- e.g. once the two sources end
        // up close enough that this side's hinge terminates directly at
        // the other's source, and that other source ALSO happens to have
        // its own hinge tracing the identical physical crease in reverse
        // (see `geometry/hingeChains.ts`'s `dedupeHingeChains`), only the
        // lexicographically-smaller id survives. Look for that survivor
        // from the other direction and use it reversed.
        const mirrored = hingeChains.find(
          (c) => signatureOf(c.sourceLegIds) === otherSig && c.termination.kind === 'skeletonVertex' && signatureOf(c.termination.legIds) === signatureOf(side.sourceLegIds),
        )
        return mirrored ? { chain: mirrored, points: [...mirrored.points].reverse(), reachesCommonLeg: false } : null
      }

      const a = resolveSide(lock.a, sigB)
      const b = resolveSide(lock.b, sigA)
      if (!a || !b) continue

      if (a.chain === b.chain) {
        // Both sides resolved to the exact same physical crease -- the
        // fully-mutual-retrace edge case where each side's own tangent leg
        // already equals the common leg, and after solving the two hinges
        // exactly retrace one another. Already one continuous line.
        out.push({ lock, points: a.points })
      } else if (a.reachesCommonLeg && b.reachesCommonLeg) {
        out.push({ lock, points: [...a.points, ...b.points.slice().reverse().slice(1)] })
      } else if (!a.reachesCommonLeg) {
        out.push({ lock, points: [...a.points, ...b.points.slice(1)] })
      } else {
        out.push({ lock, points: [...b.points, ...a.points.slice(1)] })
      }
    }
    return out
  }, [tilingGraph, hingeChains])

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
          {showTilingFlapsAndRivers && (
            <>
              {rivers.map((r) => (
                <path key={`tiling-river-${r.key}`} className="tiling-river" fillRule="evenodd" d={r.pathD} />
              ))}
              {flaps.map((f) => (
                <polygon
                  key={`tiling-flap-${f.key}`}
                  className={`tiling-flap${f.understaffed ? ' understaffed' : ''}`}
                  points={f.points}
                />
              ))}
            </>
          )}

          {skeletonNodesWithLegIds.flatMap(({ faceId, skeleton, nodes }) => {
            // Built once per face rather than re-scanned per ridge endpoint
            // (`nodes.find(...)` twice per ridge) -- `r.start`/`r.end` are
            // always the exact same `Point` object a node's own `position`
            // was built from (see `straightSkeleton.ts`'s `closeRidge`), so
            // an exact-value key is reliable, no distance-tolerance match
            // needed.
            const nodeByPosKey = new Map<string, (typeof nodes)[number]>()
            for (const n of nodes) nodeByPosKey.set(`${n.node.position.x}|${n.node.position.y}`, n)
            const nodeAt = (p: { x: number; y: number }) => nodeByPosKey.get(`${p.x}|${p.y}`)
            return skeleton.ridges.map((r, i) => {
              const [x1, y1] = toScreen(r.start.x, r.start.y)
              const [x2, y2] = toScreen(r.end.x, r.end.y)
              const className = `tiling-ridge${r.isReflexBoundary ? ' concave' : ''}`
              // An "interior" ridge (both endpoints interior straight-skeleton
              // nodes, not the original polygon boundary) is clickable --
              // resolve each endpoint to its owning node's legIds, then offer
              // the same invisible-wide-hit-line technique already used for
              // path-preview lines.
              if (!r.startIsBoundary && !r.endIsBoundary) {
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
            })
          })}
          {showTilingHinges &&
            hingeChains.map((chain) => {
              const pointsAttr = chain.points.map((p) => toScreen(p.x, p.y).join(',')).join(' ')
              const selected = tilingSelectedChainIds.includes(chain.id)
              return (
                // eslint-disable-next-line jsx-a11y/no-static-element-interactions
                <g
                  key={`tiling-hinge-${chain.id}`}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    selectTilingHingeChain(chain.id, e.shiftKey)
                  }}
                >
                  <polyline className="tiling-hinge-hit" points={pointsAttr} />
                  <polyline className={`tiling-hinge${selected ? ' selected' : ''}`} points={pointsAttr} />
                </g>
              )
            })}
          {showTilingHinges &&
            lockedConnectors.map(({ lock, points }, i) => {
              const pointsAttr = points.map((p) => toScreen(p.x, p.y).join(',')).join(' ')
              const selected = tilingSelectedHingeChainLock === lock
              return (
                // eslint-disable-next-line jsx-a11y/no-static-element-interactions
                <g
                  key={`tiling-hinge-chain-locked-${i}`}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    selectTilingHingeChainLock(lock)
                  }}
                >
                  <polyline className="tiling-hinge-hit" points={pointsAttr} />
                  <polyline className={`tiling-hinge-chain-locked${selected ? ' selected' : ''}`} points={pointsAttr} />
                </g>
              )
            })}
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
            const dotRadiusPx = v.kind === 'flap' ? TILING_FLAP_VERTEX_RADIUS_PX : TILING_INTERMEDIATE_VERTEX_RADIUS_PX
            const tick = dotRadiusPx * FREE_AXIS_TICK_FACTOR * pan.pxToWorld
            return (
              <g key={`tiling-vertex-${v.id}`}>
                <circle
                  className={`tiling-vertex-dot ${v.kind}${selected ? ' armed' : ''}`}
                  cx={x}
                  cy={y}
                  r={dotRadiusPx * pan.pxToWorld}
                  onPointerDown={(e) => beginVertexPointerDown(v.id, e)}
                />
                {free?.x && <line className="tiling-free-axis-mark" x1={x - tick} y1={y} x2={x + tick} y2={y} />}
                {free?.y && <line className="tiling-free-axis-mark" x1={x} y1={y - tick} x2={x} y2={y + tick} />}
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
                  {locked && (
                    <circle
                      className="tiling-skeleton-lock-ring"
                      cx={x}
                      cy={y}
                      r={TILING_SKELETON_LOCK_RING_RADIUS_PX * pan.pxToWorld}
                    />
                  )}
                  <circle
                    className={`tiling-skeleton-vertex-dot${selected ? ' armed' : ''}`}
                    cx={x}
                    cy={y}
                    r={TILING_SKELETON_VERTEX_RADIUS_PX * pan.pxToWorld}
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
      <TilingInspector selectedHingeChains={hingeChains.filter((c) => tilingSelectedChainIds.includes(c.id))} />
    </div>
  )
}
