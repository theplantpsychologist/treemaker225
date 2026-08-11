import { useAppStore } from '../../state/store'
import './TilingToolbar.css'

const SNAPPABLE_SHAPES = new Set(['hexagon', 'octagon', 'dodecagon'])

export function TilingToolbar() {
  const tree = useAppStore((s) => s.tree)
  const packing = useAppStore((s) => s.packing)
  const shape = useAppStore((s) => s.hyperparams.shape)
  const tilingGraph = useAppStore((s) => s.tilingGraph)
  const tilingSeeding = useAppStore((s) => s.tilingSeeding)
  const tilingSelectedVertexIds = useAppStore((s) => s.tilingSelectedVertexIds)
  const tilingSelectedLegId = useAppStore((s) => s.tilingSelectedLegId)
  const tilingPathCandidates = useAppStore((s) => s.tilingPathCandidates)
  const tilingError = useAppStore((s) => s.tilingError)
  const seedTilingGraph = useAppStore((s) => s.seedTilingGraph)
  const clearTilingError = useAppStore((s) => s.clearTilingError)

  const canSeed = Boolean(packing) && Boolean(tree.rootId) && SNAPPABLE_SHAPES.has(shape) && !tilingSeeding

  return (
    <div className="tiling-toolbar">
      <div className="tiling-toolbar-row">
        <button className="reinitialize-button" onClick={() => void seedTilingGraph()} disabled={!canSeed}>
          {tilingSeeding ? 'Seeding…' : tilingGraph ? 'Re-seed tiling' : 'Seed tiling'}
        </button>
      </div>
      {tilingGraph && (
        <div className="tiling-toolbar-hint">
          {tilingPathCandidates && 'Click one of the dashed previews to add that path, or click elsewhere to cancel.'}
          {!tilingPathCandidates &&
            tilingSelectedVertexIds.length === 1 &&
            'Shift-click a second vertex to see path options, or use the inspector.'}
          {!tilingPathCandidates &&
            tilingSelectedVertexIds.length === 0 &&
            !tilingSelectedLegId &&
            'Click a vertex to inspect it, or shift-click two vertices to connect them.'}
          {tilingSelectedLegId && 'Path selected -- use the inspector to delete it.'}
        </div>
      )}
      {tilingError && (
        <div className="solve-error">
          {tilingError}
          <button className="dismiss-error" onClick={clearTilingError}>
            ×
          </button>
        </div>
      )}
    </div>
  )
}
