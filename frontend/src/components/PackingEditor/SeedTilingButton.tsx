import { useAppStore } from '../../state/store'
import { SNAPPABLE_SHAPES } from '../../geometry/shapes'

/** Bottom-center actions for the packing pane -- the step that opens the
 * tiling pane (see `seedTilingGraph`'s `paneOpen` update in `state/store.ts`).
 * The suggested-tiling seed (hull chain + MILP-suggested interior paths) is
 * the primary accent-filled action; "manual" seeds the same bare flap
 * vertices with no legs or new constraints, for a user who wants to build
 * the tiling entirely by hand -- styled with the secondary/outline
 * (`.reinitialize-button`) treatment so the suggested seed stays the
 * default, most-visually-prominent choice. */
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
      <button className="solve-button" onClick={() => void seedTilingGraph('suggested')} disabled={!canSeed}>
        {tilingSeeding ? 'Seeding…' : tilingGraph ? 'Re-initialize suggested tiling' : 'Initialize suggested tiling'}
      </button>
      <button className="reinitialize-button" onClick={() => void seedTilingGraph('manual')} disabled={!canSeed}>
        {tilingSeeding ? 'Seeding…' : tilingGraph ? 'Re-initialize manual tiling' : 'Initialize manual tiling'}
      </button>
    </div>
  )
}
