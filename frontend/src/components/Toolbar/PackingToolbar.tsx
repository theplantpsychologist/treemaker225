import { useAppStore } from '../../state/store'
import { SymmetryModeSelector } from './SymmetryModeSelector'
import { ScaleSlider } from './ScaleSlider'
import { SettingsModal } from './SettingsModal'
import './PackingToolbar.css'

export function PackingToolbar() {
  const tree = useAppStore((s) => s.tree)
  const packing = useAppStore((s) => s.packing)
  const solving = useAppStore((s) => s.solving)
  const runSolve = useAppStore((s) => s.runSolve)
  const initializePacking = useAppStore((s) => s.initializePacking)

  if (!packing) {
    return (
      <div className="packing-toolbar">
        <button className="solve-button" onClick={initializePacking} disabled={!tree.rootId}>
          Initialize
        </button>
      </div>
    )
  }

  return (
    <div className="packing-toolbar">
      <SymmetryModeSelector />
      <ScaleSlider />
      <button className="reinitialize-button" onClick={initializePacking} disabled={!tree.rootId}>
        Re-initialize
      </button>
      <button className="solve-button" onClick={() => void runSolve()} disabled={solving || !tree.rootId}>
        {solving ? 'Optimizing…' : 'Optimize'}
      </button>
      <SettingsModal />
    </div>
  )
}
