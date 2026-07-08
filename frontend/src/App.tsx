import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import './App.css'
import { API_BASE } from './api/client'
import { TreeEditorCanvas } from './components/TreeEditor/TreeEditorCanvas'
import { PackingEditorCanvas } from './components/PackingEditor/PackingEditorCanvas'
import { PackingToolbar } from './components/Toolbar/PackingToolbar'
import { ShapeSelector } from './components/Toolbar/ShapeSelector'
import { ConstraintLegend } from './components/ConstraintLegend/ConstraintLegend'
import { UndoRedoControls } from './components/UndoRedo/UndoRedoControls'
import { ThemeToggle } from './components/Theme/ThemeToggle'
import { useAppStore } from './state/store'
import { useShapeTheme } from './hooks/useShapeTheme'

const MIN_SPLIT = 20
const MAX_SPLIT = 80

function App() {
  const [backendStatus, setBackendStatus] = useState<'checking' | 'ok' | 'error'>('checking')
  const solveError = useAppStore((s) => s.solveError)
  const uiError = useAppStore((s) => s.uiError)
  const clearUiError = useAppStore((s) => s.clearUiError)
  const packing = useAppStore((s) => s.packing)
  const shape = useAppStore((s) => s.hyperparams.shape)
  const [splitPercent, setSplitPercent] = useState(50)
  const mainRef = useRef<HTMLElement>(null)
  const draggingDivider = useRef(false)

  useShapeTheme(shape)

  useEffect(() => {
    fetch(`${API_BASE}/api/health`)
      .then((res) => res.json())
      .then((data) => setBackendStatus(data.status === 'ok' ? 'ok' : 'error'))
      .catch(() => setBackendStatus('error'))
  }, [])

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
        <h1>Treemaker Pro</h1>
        <span className={`backend-status backend-status--${backendStatus}`}>backend: {backendStatus}</span>
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
            <ConstraintLegend />
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
            <div className="pane-status-stack">
              {solveError && <div className="solve-error">{solveError}</div>}
              {packing && (
                <div className="diagnostics-badge">
                  {packing.diagnostics.restartsAttempted} restart{packing.diagnostics.restartsAttempted === 1 ? '' : 's'}
                  {' · '}
                  circle {packing.diagnostics.bestScaleCircle.toFixed(4)}
                  {packing.diagnostics.bestScaleRefined != null &&
                    ` → refined ${packing.diagnostics.bestScaleRefined.toFixed(4)}`}
                  {' · '}
                  {packing.diagnostics.solveTimeMs.toFixed(0)}ms
                </div>
              )}
            </div>
            <PackingEditorCanvas />
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
