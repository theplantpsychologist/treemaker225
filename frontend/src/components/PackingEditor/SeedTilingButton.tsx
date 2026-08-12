import { useAppStore } from '../../state/store'
import { SNAPPABLE_SHAPES } from '../../geometry/shapes'

/** Bottom-center primary action for the packing pane -- the step that opens
 * the tiling pane (see `seedTilingGraph`'s `paneOpen` update in
 * `state/store.ts`). Always styled as the accent-filled main action
 * (`.solve-button`), not the secondary/outline style the old toolbar used,
 * since this is now the pane's one deliberate call to action. */
export function SeedTilingButton() {
  const tree = useAppStore((s) => s.tree)
  const packing = useAppStore((s) => s.packing)
  const shape = useAppStore((s) => s.hyperparams.shape)
  const tilingGraph = useAppStore((s) => s.tilingGraph)
  const tilingSeeding = useAppStore((s) => s.tilingSeeding)
  const seedTilingGraph = useAppStore((s) => s.seedTilingGraph)

  const canSeed = Boolean(packing) && Boolean(tree.rootId) && SNAPPABLE_SHAPES.has(shape) && !tilingSeeding

  return (
    <div className="pane-bottom-action">
      <button className="solve-button" onClick={() => void seedTilingGraph()} disabled={!canSeed}>
        {tilingSeeding ? 'Seeding…' : tilingGraph ? 'Re-initialize tiling' : 'Initialize tiling'}
      </button>
    </div>
  )
}
