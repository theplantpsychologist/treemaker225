import { useAppStore } from '../../state/store'

/** Placeholder bottom-center action for the tiling pane -- lights up once
 * the tiling graph has zero remaining degrees of freedom (see
 * `tilingGraph.dof`, computed in `tilingGraphActions.ts`'s `finalize`).
 * Doesn't render a crease pattern yet; clicking it just reveals the (still
 * blank) output viewer pane. */
export function RenderCreasePatternButton() {
  const tilingGraph = useAppStore((s) => s.tilingGraph)
  const setPaneOpen = useAppStore((s) => s.setPaneOpen)

  const canRender = Boolean(tilingGraph) && tilingGraph!.dof === 0

  return (
    <div className="pane-bottom-action">
      <button className="solve-button" disabled={!canRender} onClick={() => setPaneOpen('output', true)}>
        Render crease pattern
      </button>
    </div>
  )
}
