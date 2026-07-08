import { useRef } from 'react'
import type { ChangeEvent } from 'react'
import { useAppStore } from '../../state/store'
import { IconButton } from '../icons/IconButton'
import undoIcon from '../../assets/undo.svg'
import redoIcon from '../../assets/redo.svg'
import trashIcon from '../../assets/trash.svg'
import downloadIcon from '../../assets/download.svg'
import uploadIcon from '../../assets/upload.svg'
import './UndoRedoControls.css'

export function UndoRedoControls() {
  const canUndo = useAppStore((s) => s.undoStack.length > 0)
  const canRedo = useAppStore((s) => s.redoStack.length > 0)
  const undo = useAppStore((s) => s.undo)
  const redo = useAppStore((s) => s.redo)
  const startOver = useAppStore((s) => s.startOver)
  const exportSession = useAppStore((s) => s.exportSession)
  const importSession = useAppStore((s) => s.importSession)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const onStartOver = () => {
    if (window.confirm('Start over? This clears the current tree, constraints, and packing.')) {
      startOver()
    }
  }

  const onImportClick = () => fileInputRef.current?.click()

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string)
        importSession(data)
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to import session')
      }
    }
    reader.readAsText(file)
  }

  return (
    <div className="undo-redo-controls">
      <IconButton icon={undoIcon} label="Undo" onClick={undo} disabled={!canUndo} />
      <IconButton icon={redoIcon} label="Redo" onClick={redo} disabled={!canRedo} />
      <IconButton icon={trashIcon} label="Clear everything and start over" onClick={onStartOver} />
      <span className="undo-redo-divider" />
      <IconButton icon={downloadIcon} label="Export session" onClick={exportSession} />
      <IconButton icon={uploadIcon} label="Import session" onClick={onImportClick} />
      <input ref={fileInputRef} type="file" accept="application/json" hidden onChange={onFileChange} />
    </div>
  )
}
