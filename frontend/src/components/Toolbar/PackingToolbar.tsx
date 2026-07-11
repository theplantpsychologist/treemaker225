import { useAppStore } from '../../state/store'
import { SymmetryModeSelector } from './SymmetryModeSelector'
import { ScaleSlider } from './ScaleSlider'
import { SettingsModal } from './SettingsModal'
import './PackingToolbar.css'

const SNAPPABLE_SHAPES = new Set(['hexagon', 'octagon', 'dodecagon'])

export function PackingToolbar() {
  const tree = useAppStore((s) => s.tree)
  const packing = useAppStore((s) => s.packing)
  const shape = useAppStore((s) => s.hyperparams.shape)
  const solving = useAppStore((s) => s.solving)
  const runSolve = useAppStore((s) => s.runSolve)
  const initializePacking = useAppStore((s) => s.initializePacking)
  const snapActivePaths = useAppStore((s) => s.snapActivePaths)
  const snapPathNetwork = useAppStore((s) => s.snapPathNetwork)

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
      {SNAPPABLE_SHAPES.has(shape) && (
        <button
          className="reinitialize-button"
          onClick={() => void snapActivePaths()}
          disabled={solving || !tree.rootId}
        >
          Snap paths
        </button>
      )}
      {SNAPPABLE_SHAPES.has(shape) && (
        <button
          className="reinitialize-button"
          onClick={() => void snapPathNetwork()}
          disabled={solving || !tree.rootId}
        >
          Snap path network
        </button>
      )}
      <SettingsModal />
    </div>
  )
}
