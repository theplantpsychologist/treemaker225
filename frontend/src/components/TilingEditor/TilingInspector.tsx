import { useAppStore } from '../../state/store'
import type { CornerId, EdgeSide, LeafConstraint } from '../../types/constraints'
import { NO_LEAF_CONSTRAINT } from '../../types/constraints'
import { isFullyFixedBySymmetryBoundary } from '../../geometry/constraintResolution'
import { signatureOf } from '../../geometry/tilingCotangent'
import type { ChainTermination, HingeChain } from '../../geometry/hingeChains'
import { IconButton } from '../icons/IconButton'
import pinSymmetryIcon from '../../assets/pin_symmetry.svg'
import lockIcon from '../../assets/lock.svg'
import clearIcon from '../../assets/clear.svg'
import trashIcon from '../../assets/trash.svg'
import '../PackingEditor/Inspector.css'
import './TilingInspector.css'

const EDGE_SIDES: EdgeSide[] = ['top', 'bottom', 'left', 'right']
const CORNER_IDS: CornerId[] = ['top_left', 'top_right', 'bottom_left', 'bottom_right']

function edgeAbbrev(edge: EdgeSide) {
  return edge === 'top' ? 'T' : edge === 'bottom' ? 'B' : edge === 'left' ? 'L' : 'R'
}

function cornerAbbrev(corner: CornerId) {
  return corner
    .split('_')
    .map((w) => w[0].toUpperCase())
    .join('')
}

function symmetryLabel(constraint: LeafConstraint) {
  const s = constraint.symmetry
  if (s.kind === 'pin_symmetry') return 'pinned to symmetry line'
  if (s.kind === 'pair') return `paired with ${s.pairedWith.slice(0, 6)} (from packing)`
  return 'none'
}

function boundaryLabel(constraint: LeafConstraint) {
  const b = constraint.boundary
  if (b.kind === 'pin_edge') return `pinned to ${b.edge} edge`
  if (b.kind === 'pin_corner') return `pinned to ${b.corner.replace('_', ' ')} corner`
  return 'none'
}

function terminationLabel(t: ChainTermination): string {
  if (t.kind === 'vertex') return `flap/junction ${t.vertexId.slice(0, 6)}`
  if (t.kind === 'skeletonVertex') return `incircle vertex (${t.legIds.length} edges)`
  if (t.kind === 'boundary') return 'paper edge'
  return 'incomplete (hit the bounce cap)'
}

/** Mirrors `PackingEditor/Inspector.tsx`'s rail/panel/group structure for
 * the manual tiling editor: a selected vertex shows its (independently
 * copied, see `TilingGraphState.constraints`) symmetry/boundary/lock
 * constraints and a delete button; a selected leg shows its angle and a
 * delete button. Edge/corner pins commit directly on click (no
 * arm-then-click-a-canvas-handle flow, unlike packing's Inspector -- there's
 * only 4 of each, so a compact button row here is simpler than adding a
 * second canvas overlay). */
/** `selectedHingeChains` -- the live `HingeChain` objects matching
 * `tilingSelectedChainIds` -- is passed down from `TilingEditorCanvas.tsx`
 * rather than read from the store: hinge chains are recomputed fresh every
 * render there (so they stay visually live while dragging without a store
 * write, see that file's doc), so this is the only component that has them
 * on hand. May be shorter than `tilingSelectedChainIds` for a render or two
 * right after a topology change invalidates one of the selected ids. */
export function TilingInspector({ selectedHingeChains }: { selectedHingeChains: HingeChain[] }) {
  const tilingGraph = useAppStore((s) => s.tilingGraph)
  const tilingSelectedVertexIds = useAppStore((s) => s.tilingSelectedVertexIds)
  const tilingSelectedLegId = useAppStore((s) => s.tilingSelectedLegId)
  const tilingSkeletonSelection = useAppStore((s) => s.tilingSkeletonSelection)
  const tilingSelectedChainIds = useAppStore((s) => s.tilingSelectedChainIds)
  const tilingSelectedHingeChainLock = useAppStore((s) => s.tilingSelectedHingeChainLock)
  const releaseHingeChainLock = useAppStore((s) => s.releaseHingeChainLock)
  const lockTilingSkeletonVertex = useAppStore((s) => s.lockTilingSkeletonVertex)
  const unlockTilingSkeletonVertex = useAppStore((s) => s.unlockTilingSkeletonVertex)
  const mergeTilingSkeletonVertices = useAppStore((s) => s.mergeTilingSkeletonVertices)
  const pinTilingVertexToSymmetry = useAppStore((s) => s.pinTilingVertexToSymmetry)
  const pinTilingVertexToEdge = useAppStore((s) => s.pinTilingVertexToEdge)
  const pinTilingVertexToCorner = useAppStore((s) => s.pinTilingVertexToCorner)
  const clearTilingVertexSymmetry = useAppStore((s) => s.clearTilingVertexSymmetry)
  const clearTilingVertexBoundary = useAppStore((s) => s.clearTilingVertexBoundary)
  const toggleTilingVertexLock = useAppStore((s) => s.toggleTilingVertexLock)
  const deleteSelectedTilingVertex = useAppStore((s) => s.deleteSelectedTilingVertex)
  const deleteSelectedTilingLeg = useAppStore((s) => s.deleteSelectedTilingLeg)
  const clearTilingSelection = useAppStore((s) => s.clearTilingSelection)
  const selectTilingLeg = useAppStore((s) => s.selectTilingLeg)

  if (!tilingGraph) return null

  if (tilingSkeletonSelection?.kind === 'vertex') {
    const { legIds } = tilingSkeletonSelection
    const degree = legIds.length
    const isLocked = tilingGraph.skeletonLocks.some((l) => signatureOf(l.legIds) === signatureOf(legIds))
    return (
      <div className="inspector-rail">
        <div className="inspector-panel">
          <div className="inspector-panel-header">
            <span className="inspector-label">incircle vertex: {degree} edges</span>
            <IconButton icon={clearIcon} label="Deselect" onClick={clearTilingSelection} />
          </div>
          <div className="inspector-group-buttons">
            <IconButton
              icon={lockIcon}
              label={isLocked ? 'Unlock cotangent incircle' : 'Lock cotangent incircle'}
              active={isLocked}
              disabled={!isLocked && degree < 4}
              onClick={() => (isLocked ? unlockTilingSkeletonVertex(legIds) : lockTilingSkeletonVertex(legIds))}
            />
          </div>
        </div>
      </div>
    )
  }

  if (tilingSkeletonSelection?.kind === 'ridge') {
    const { legIdsA, legIdsB } = tilingSkeletonSelection
    return (
      <div className="inspector-rail">
        <div className="inspector-panel">
          <div className="inspector-panel-header">
            <span className="inspector-label">interior edge</span>
            <IconButton icon={clearIcon} label="Deselect" onClick={clearTilingSelection} />
          </div>
          <button className="inspector-text-button" onClick={() => mergeTilingSkeletonVertices(legIdsA, legIdsB)}>
            Merge
          </button>
        </div>
      </div>
    )
  }

  // A selected, already-committed chain-collinearity lock -- checked before
  // the plain single-chain view-only branch below since the two selection
  // fields are mutually exclusive by construction (see
  // `tilingSelectedHingeChainLock`'s doc in `state/store.ts`).
  if (tilingSelectedHingeChainLock) {
    const lock = tilingSelectedHingeChainLock
    return (
      <div className="inspector-rail">
        <div className="inspector-panel">
          <div className="inspector-panel-header">
            <span className="inspector-label">chain collinearity lock</span>
            <IconButton icon={clearIcon} label="Deselect" onClick={clearTilingSelection} />
          </div>
          <span className="inspector-width">{lock.a.sourceLegIds.length}-edge and {lock.b.sourceLegIds.length}-edge incircle vertices, connected</span>
          <button className="inspector-text-button" onClick={() => releaseHingeChainLock(lock)}>
            Release constraint
          </button>
        </div>
      </div>
    )
  }

  // A single selected hinge chain -- view-only, no operations (per the
  // manual editor's spec: chains are a read-only diagnostic until two of
  // them are selected, which attempts the chain-collinearity lock instead
  // of showing anything here -- see `TilingEditorCanvas.tsx`).
  if (tilingSelectedChainIds.length === 1) {
    const chain = selectedHingeChains[0]
    if (!chain) return null
    const legCrossingCount = chain.crossings.filter((c) => c.anchor.kind === 'leg').length
    return (
      <div className="inspector-rail">
        <div className="inspector-panel">
          <div className="inspector-panel-header">
            <span className="inspector-label">hinge chain</span>
            <IconButton icon={clearIcon} label="Deselect" onClick={clearTilingSelection} />
          </div>
          <span className="inspector-width">source: {chain.sourceLegIds.length}-edge incircle vertex</span>
          <span className="inspector-width">crosses {legCrossingCount} path leg{legCrossingCount === 1 ? '' : 's'}</span>
          <span className="inspector-width">ends at: {terminationLabel(chain.termination)}</span>
        </div>
      </div>
    )
  }

  if (tilingSelectedLegId) {
    const leg = tilingGraph.legs[tilingSelectedLegId]
    if (!leg) return null
    return (
      <div className="inspector-rail">
        <div className="inspector-panel">
          <div className="inspector-panel-header">
            <span className="inspector-label">path: {leg.id.slice(0, 6)}</span>
            <div className="inspector-group-buttons">
              <IconButton icon={trashIcon} label="Delete path" className="danger" onClick={deleteSelectedTilingLeg} />
              <IconButton icon={clearIcon} label="Deselect" onClick={() => selectTilingLeg(null)} />
            </div>
          </div>
          <span className="inspector-width">angle: {((leg.angle * 180) / Math.PI).toFixed(1)}°</span>
        </div>
      </div>
    )
  }

  if (tilingSelectedVertexIds.length !== 1) return null
  const vertexId = tilingSelectedVertexIds[0]
  const vertex = tilingGraph.vertices[vertexId]
  if (!vertex) return null

  const flapId = vertex.flapId
  const constraint = flapId ? tilingGraph.constraints.perLeaf[flapId] ?? NO_LEAF_CONSTRAINT : NO_LEAF_CONSTRAINT
  const symmetryMode = tilingGraph.constraints.symmetryMode
  const hasLegs = Object.values(tilingGraph.legs).some((l) => l.vertexA === vertexId || l.vertexB === vertexId)

  return (
    <div className="inspector-rail tiling-inspector-rail">
      <div className="inspector-panel">
        <div className="inspector-panel-header">
          <span className="inspector-label">
            {vertex.kind === 'flap' ? 'flap' : 'junction'}: {vertexId.slice(0, 6)}
          </span>
          <div className="inspector-group-buttons">
            <IconButton
              icon={trashIcon}
              label="Delete all paths at this vertex"
              className="danger"
              disabled={!hasLegs}
              onClick={deleteSelectedTilingVertex}
            />
            <IconButton icon={clearIcon} label="Deselect" onClick={clearTilingSelection} />
          </div>
        </div>

        {flapId && (
          <>
            <div className="inspector-group">
              <span className="inspector-group-label">symmetry constraint: {symmetryLabel(constraint)}</span>
              <div className="inspector-group-buttons">
                <IconButton
                  icon={pinSymmetryIcon}
                  label="Pin to symmetry line"
                  active={constraint.symmetry.kind === 'pin_symmetry'}
                  disabled={symmetryMode === 'none'}
                  onClick={() => pinTilingVertexToSymmetry(flapId)}
                />
                <IconButton
                  icon={clearIcon}
                  label="Clear symmetry constraint"
                  disabled={constraint.symmetry.kind === 'none'}
                  onClick={() => clearTilingVertexSymmetry(flapId)}
                />
              </div>
            </div>

            <div className="inspector-group">
              <span className="inspector-group-label">boundary constraint: {boundaryLabel(constraint)}</span>
              <div className="inspector-group-buttons tiling-pin-grid">
                {EDGE_SIDES.map((edge) => (
                  <button
                    key={edge}
                    className={`tiling-pin-button${constraint.boundary.kind === 'pin_edge' && constraint.boundary.edge === edge ? ' active' : ''}`}
                    title={`Pin to ${edge} edge`}
                    onClick={() => pinTilingVertexToEdge(flapId, edge)}
                  >
                    {edgeAbbrev(edge)}
                  </button>
                ))}
                {CORNER_IDS.map((corner) => (
                  <button
                    key={corner}
                    className={`tiling-pin-button${constraint.boundary.kind === 'pin_corner' && constraint.boundary.corner === corner ? ' active' : ''}`}
                    title={`Pin to ${corner.replace('_', ' ')} corner`}
                    onClick={() => pinTilingVertexToCorner(flapId, corner)}
                  >
                    {cornerAbbrev(corner)}
                  </button>
                ))}
                <IconButton
                  icon={clearIcon}
                  label="Clear edge/corner constraint"
                  disabled={constraint.boundary.kind === 'none'}
                  onClick={() => clearTilingVertexBoundary(flapId)}
                />
              </div>
            </div>

            <div className="inspector-group">
              <span className="inspector-group-label">{constraint.locked.kind === 'locked' ? 'locked in place' : 'not locked'}</span>
              <div className="inspector-group-buttons">
                <IconButton
                  icon={lockIcon}
                  label={constraint.locked.kind === 'locked' ? 'Unlock' : 'Lock in place'}
                  active={constraint.locked.kind === 'locked'}
                  disabled={
                    constraint.locked.kind !== 'locked' &&
                    (isFullyFixedBySymmetryBoundary(symmetryMode, constraint) ||
                      (constraint.symmetry.kind === 'pair' && flapId > constraint.symmetry.pairedWith))
                  }
                  onClick={() => toggleTilingVertexLock(flapId)}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
