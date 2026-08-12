import { useAppStore } from '../../state/store'
import { countNonRootLeaves } from '../../geometry/treeGeometry'

/** Bottom-center action for the tree pane -- the entry point into the rest
 * of the workflow. A single button relabeled by whether a packing already
 * exists (mirrors the old PackingToolbar's Initialize/Re-initialize
 * pattern), gated on the tree having at least 3 real (non-root) leaves --
 * fewer than that can't form a meaningful packing. */
export function TreeBottomActions() {
  const tree = useAppStore((s) => s.tree)
  const packing = useAppStore((s) => s.packing)
  const initializePacking = useAppStore((s) => s.initializePacking)

  const canInitialize = Boolean(tree.rootId) && countNonRootLeaves(tree) >= 3

  return (
    <div className="pane-bottom-action">
      <button
        className={packing ? 'reinitialize-button' : 'solve-button'}
        onClick={initializePacking}
        disabled={!canInitialize}
      >
        {packing ? 'Re-initialize packing' : 'Initialize packing'}
      </button>
    </div>
  )
}
