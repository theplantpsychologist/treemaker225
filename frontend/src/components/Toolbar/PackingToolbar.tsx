import { useAppStore } from '../../state/store'
import { SymmetryModeSelector } from './SymmetryModeSelector'
import { ScaleSlider } from './ScaleSlider'
import './PackingToolbar.css'

/** The packing pane is only ever open once `packing` exists -- see
 * `paneOpen` in `state/store.ts` -- so this can assume a packing is
 * present. "Initialize"/"Re-initialize" now live in the tree pane
 * (`TreeBottomActions.tsx`), one step earlier in the workflow. */
export function PackingToolbar() {
  const packing = useAppStore((s) => s.packing)
  const tree = useAppStore((s) => s.tree)
  const solving = useAppStore((s) => s.solving)
  const runSolve = useAppStore((s) => s.runSolve)

  if (!packing) return null

  return (
    <div className="packing-toolbar">
      <SymmetryModeSelector />
      <ScaleSlider />
      <button className="solve-button" onClick={() => void runSolve()} disabled={solving || !tree.rootId}>
        {solving ? 'Optimizing…' : 'Optimize'}
      </button>
    </div>
  )
}
