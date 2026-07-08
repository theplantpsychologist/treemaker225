import { useAppStore } from '../../state/store'
import { SymmetryModeSelector } from './SymmetryModeSelector'
import { ShapeSelector } from './ShapeSelector'
import { ScaleSlider } from './ScaleSlider'
import { SettingsModal } from './SettingsModal'
import './PackingToolbar.css'

export function PackingToolbar() {
  const tree = useAppStore((s) => s.tree)
  const solving = useAppStore((s) => s.solving)
  const runSolve = useAppStore((s) => s.runSolve)

  return (
    <div className="packing-toolbar">
      <SymmetryModeSelector />
      <ShapeSelector />
      <ScaleSlider />
      <button className="solve-button" onClick={() => void runSolve()} disabled={solving || !tree.rootId}>
        {solving ? 'Solving…' : 'Solve'}
      </button>
      <SettingsModal />
    </div>
  )
}
