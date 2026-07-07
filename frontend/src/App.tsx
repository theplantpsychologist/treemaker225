import { useEffect, useState } from 'react'
import './App.css'
import { API_BASE } from './api/client'
import { TreeEditorCanvas } from './components/TreeEditor/TreeEditorCanvas'
import { PackingEditorCanvas } from './components/PackingEditor/PackingEditorCanvas'
import { HyperparamsPanel } from './components/Toolbar/HyperparamsPanel'
import { SymmetryModeSelector } from './components/Toolbar/SymmetryModeSelector'
import { ConstraintLegend } from './components/ConstraintLegend/ConstraintLegend'
import { SaveLoadControls } from './components/SaveLoad/SaveLoadControls'
import { useAppStore } from './state/store'

function App() {
  const [backendStatus, setBackendStatus] = useState<'checking' | 'ok' | 'error'>('checking')
  const solveError = useAppStore((s) => s.solveError)
  const packing = useAppStore((s) => s.packing)

  useEffect(() => {
    fetch(`${API_BASE}/api/health`)
      .then((res) => res.json())
      .then((data) => setBackendStatus(data.status === 'ok' ? 'ok' : 'error'))
      .catch(() => setBackendStatus('error'))
  }, [])

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>treemaker225</h1>
        <span className={`backend-status backend-status--${backendStatus}`}>backend: {backendStatus}</span>
        <SaveLoadControls />
      </header>
      <main className="app-main">
        <section className="pane tree-pane">
          <div className="pane-header">
            <h2>Tree</h2>
            <div className="pane-toolbar">
              <SymmetryModeSelector />
            </div>
          </div>
          <div className="pane-body">
            <TreeEditorCanvas />
            <ConstraintLegend />
          </div>
        </section>
        <section className="pane packing-pane">
          <div className="pane-header">
            <h2>Packing</h2>
            <HyperparamsPanel />
          </div>
          <div className="pane-body">
            <div className="pane-status-stack">
              {solveError && <div className="solve-error">{solveError}</div>}
              {packing && (
                <div className="diagnostics-badge">
                  {packing.diagnostics.restartsAttempted} restart{packing.diagnostics.restartsAttempted === 1 ? '' : 's'}
                  {' · '}
                  circle {packing.diagnostics.bestScaleCircle.toFixed(4)}
                  {packing.diagnostics.bestScaleOctagon != null &&
                    ` → octagon ${packing.diagnostics.bestScaleOctagon.toFixed(4)}`}
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
