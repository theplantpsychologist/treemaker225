import { useAppStore } from '../../state/store'
import './UndoRedoControls.css'

export function UndoRedoControls() {
  const canUndo = useAppStore((s) => s.undoStack.length > 0)
  const canRedo = useAppStore((s) => s.redoStack.length > 0)
  const undo = useAppStore((s) => s.undo)
  const redo = useAppStore((s) => s.redo)
  const startOver = useAppStore((s) => s.startOver)

  const onStartOver = () => {
    if (window.confirm('Start over? This clears the current tree, constraints, and packing.')) {
      startOver()
    }
  }

  return (
    <div className="undo-redo-controls">
      <button onClick={undo} disabled={!canUndo} title="Undo">
        Undo
      </button>
      <button onClick={redo} disabled={!canRedo} title="Redo">
        Redo
      </button>
      <button onClick={onStartOver} title="Clear everything and start over">
        Start Over
      </button>
    </div>
  )
}
