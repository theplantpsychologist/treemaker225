import { useAppStore } from '../../state/store'
import './TilingToolbar.css'

/** Toggle + hint/error strip for the tiling pane -- the "Seed tiling" action
 * itself now lives in the packing pane (`SeedTilingButton.tsx`), one step
 * earlier in the workflow. The show/hide toggle stays available as soon as
 * there's a packing to draw flaps/rivers from (even before a tiling graph
 * exists); the rest renders nothing once there's neither a graph to hint
 * about nor an error to show. */
export function TilingToolbar() {
  const packing = useAppStore((s) => s.packing)
  const tilingGraph = useAppStore((s) => s.tilingGraph)
  const tilingSelectedVertexIds = useAppStore((s) => s.tilingSelectedVertexIds)
  const tilingSelectedLegId = useAppStore((s) => s.tilingSelectedLegId)
  const tilingPathCandidates = useAppStore((s) => s.tilingPathCandidates)
  const tilingError = useAppStore((s) => s.tilingError)
  const clearTilingError = useAppStore((s) => s.clearTilingError)
  const showTilingFlapsAndRivers = useAppStore((s) => s.showTilingFlapsAndRivers)
  const setShowTilingFlapsAndRivers = useAppStore((s) => s.setShowTilingFlapsAndRivers)

  if (!packing && !tilingError) return null

  return (
    <div className="tiling-toolbar">
      <div className="tiling-toolbar-row">
        <label className="tiling-switch">
          <input
            type="checkbox"
            checked={showTilingFlapsAndRivers}
            onChange={(e) => setShowTilingFlapsAndRivers(e.target.checked)}
          />
          <span className="tiling-switch-track">
            <span className="tiling-switch-thumb" />
          </span>
          show flaps &amp; rivers
        </label>
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
