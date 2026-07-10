import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import './App.css'
import { TreeEditorCanvas } from './components/TreeEditor/TreeEditorCanvas'
import { PackingEditorCanvas } from './components/PackingEditor/PackingEditorCanvas'
import { PackingToolbar } from './components/Toolbar/PackingToolbar'
import { ShapeSelector } from './components/Toolbar/ShapeSelector'
import { UndoRedoControls } from './components/UndoRedo/UndoRedoControls'
import { ThemeToggle } from './components/Theme/ThemeToggle'
import { useAppStore } from './state/store'
import { useShapeTheme } from './hooks/useShapeTheme'

const MIN_SPLIT = 20
const MAX_SPLIT = 80

function App() {
  const uiError = useAppStore((s) => s.uiError)
  const clearUiError = useAppStore((s) => s.clearUiError)
  const shape = useAppStore((s) => s.hyperparams.shape)
  const undo = useAppStore((s) => s.undo)
  const redo = useAppStore((s) => s.redo)
  const [splitPercent, setSplitPercent] = useState(50)
  const mainRef = useRef<HTMLElement>(null)
  const draggingDivider = useRef(false)

  useShapeTheme(shape)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isTyping = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      if (isTyping) return
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  const onDividerPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    draggingDivider.current = true
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // best-effort
    }
  }, [])

  const onDividerPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingDivider.current || !mainRef.current) return
    const rect = mainRef.current.getBoundingClientRect()
    const percent = ((e.clientX - rect.left) / rect.width) * 100
    setSplitPercent(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, percent)))
  }, [])

  const onDividerPointerUp = useCallback(() => {
    draggingDivider.current = false
  }, [])
  return (
    <div className="app-shell">
      <header className="app-header">
        <title>Treemaker Plus</title>
        <h1>Treemaker Plus</h1>
        <ShapeSelector />
        <UndoRedoControls />
        <ThemeToggle />
      </header>
      <main className="app-main" ref={mainRef}>
        <section className="pane tree-pane" style={{ flex: `0 0 ${splitPercent}%` }}>
          <div className="pane-header">
            <h2>Tree Editor</h2>
          </div>
          <div className="pane-body">
            {uiError && (
              <div className="pane-status-stack">
                <div className="solve-error">
                  {uiError}
                  <button className="dismiss-error" onClick={clearUiError}>
                    ×
                  </button>
                </div>
              </div>
            )}
            <TreeEditorCanvas />
          </div>
        </section>
        <div
          className="pane-divider"
          onPointerDown={onDividerPointerDown}
          onPointerMove={onDividerPointerMove}
          onPointerUp={onDividerPointerUp}
          onPointerLeave={onDividerPointerUp}
        />
        <section className="pane packing-pane" style={{ flex: '1 1 auto' }}>
          <div className="pane-header">
            <h2>Packing Editor</h2>
          </div>
          <PackingToolbar />
          <div className="pane-body">
            <PackingEditorCanvas />
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
