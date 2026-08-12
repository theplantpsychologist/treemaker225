import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import './App.css'
import { TreeEditorCanvas } from './components/TreeEditor/TreeEditorCanvas'
import { TreeBottomActions } from './components/TreeEditor/TreeBottomActions'
import { PackingEditorCanvas } from './components/PackingEditor/PackingEditorCanvas'
import { SeedTilingButton } from './components/PackingEditor/SeedTilingButton'
import { TilingEditorCanvas } from './components/TilingEditor/TilingEditorCanvas'
import { TilingToolbar } from './components/TilingEditor/TilingToolbar'
import { RenderCreasePatternButton } from './components/TilingEditor/RenderCreasePatternButton'
import { OutputViewer } from './components/OutputViewer/OutputViewer'
import { PackingToolbar } from './components/Toolbar/PackingToolbar'
import { ShapeSelector } from './components/Toolbar/ShapeSelector'
import { UndoRedoControls } from './components/UndoRedo/UndoRedoControls'
import { ThemeToggle } from './components/Theme/ThemeToggle'
import { SettingsModal } from './components/Toolbar/SettingsModal'
import { useAppStore } from './state/store'
import type { PaneId } from './state/store'
import { useShapeTheme } from './hooks/useShapeTheme'

/** Collapsed-pane strip width, in px -- a fixed flex-basis regardless of
 * viewport size (unlike an open pane's flex-grow share). */
const STRIP_WIDTH_PX = 40
/** Neither side of a divider drag may shrink below this fraction of the two
 * panes' combined flex-grow, so a pane can never be dragged fully closed
 * (closing is the X button's job, not the divider's). */
const MIN_FLEX_SHARE = 0.22

const PANE_ORDER: PaneId[] = ['tree', 'packing', 'tiling', 'output']
const PANE_TITLE: Record<PaneId, string> = {
  tree: 'Tree Editor',
  packing: 'Packing Editor',
  tiling: 'Tiling Editor',
  output: 'Output Viewer',
}

interface DividerDrag {
  leftId: PaneId
  rightId: PaneId
  startClientX: number
  startLeftFlex: number
  startRightFlex: number
  /** flex-grow units per screen pixel, fixed for the duration of one drag
   * gesture -- computed once at pointerdown from the pixel width currently
   * available to open panes, so a drag doesn't need to re-derive it (and
   * potentially jitter) on every pointermove. */
  flexPerPx: number
}

function App() {
  const uiError = useAppStore((s) => s.uiError)
  const clearUiError = useAppStore((s) => s.clearUiError)
  const shape = useAppStore((s) => s.hyperparams.shape)
  const undo = useAppStore((s) => s.undo)
  const redo = useAppStore((s) => s.redo)
  const paneOpen = useAppStore((s) => s.paneOpen)
  const setPaneOpen = useAppStore((s) => s.setPaneOpen)

  const [paneFlex, setPaneFlex] = useState<Record<PaneId, number>>({ tree: 1, packing: 1, tiling: 1, output: 1 })
  const [isDragging, setIsDragging] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const dragRef = useRef<DividerDrag | null>(null)

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

  const onDividerPointerDown = useCallback(
    (leftId: PaneId, rightId: PaneId) => (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!paneOpen[leftId] || !paneOpen[rightId] || !mainRef.current) return
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // best-effort; drag still works via the divider's own move/up listeners
      }
      const rect = mainRef.current.getBoundingClientRect()
      const openCount = PANE_ORDER.filter((id) => paneOpen[id]).length
      const collapsedCount = PANE_ORDER.length - openCount
      const totalOpenFlex = PANE_ORDER.filter((id) => paneOpen[id]).reduce((sum, id) => sum + paneFlex[id], 0)
      const availablePx = Math.max(1, rect.width - collapsedCount * STRIP_WIDTH_PX)
      setIsDragging(true)
      dragRef.current = {
        leftId,
        rightId,
        startClientX: e.clientX,
        startLeftFlex: paneFlex[leftId],
        startRightFlex: paneFlex[rightId],
        flexPerPx: totalOpenFlex / availablePx,
      }
    },
    [paneOpen, paneFlex],
  )

  const onDividerPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const deltaFlex = (e.clientX - drag.startClientX) * drag.flexPerPx
    const pairTotal = drag.startLeftFlex + drag.startRightFlex
    const floor = pairTotal * MIN_FLEX_SHARE
    const newLeft = Math.min(pairTotal - floor, Math.max(floor, drag.startLeftFlex + deltaFlex))
    setPaneFlex((prev) => ({ ...prev, [drag.leftId]: newLeft, [drag.rightId]: pairTotal - newLeft }))
  }, [])

  const onDividerPointerUp = useCallback(() => {
    dragRef.current = null
    setIsDragging(false)
  }, [])

  const renderPaneBody = (id: PaneId): { toolbar: ReactNode; body: ReactNode } => {
    switch (id) {
      case 'tree':
        return {
          toolbar: null,
          body: (
            <>
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
              <TreeBottomActions />
            </>
          ),
        }
      case 'packing':
        return {
          toolbar: <PackingToolbar />,
          body: (
            <>
              <PackingEditorCanvas />
              <SeedTilingButton />
            </>
          ),
        }
      case 'tiling':
        return {
          toolbar: <TilingToolbar />,
          body: (
            <>
              <TilingEditorCanvas />
              <RenderCreasePatternButton />
            </>
          ),
        }
      case 'output':
        return { toolbar: null, body: <OutputViewer /> }
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <title>Treemaker Plus</title>
        <h1>Treemaker Plus</h1>
        <ShapeSelector />
        <UndoRedoControls />
        <ThemeToggle />
        <SettingsModal />
      </header>
      <main className={`app-main${isDragging ? ' dragging' : ''}`} ref={mainRef}>
        {PANE_ORDER.map((id, i) => {
          const isOpen = paneOpen[id]
          const { toolbar, body } = renderPaneBody(id)
          const prevId = PANE_ORDER[i - 1]
          const dividerLive = i > 0 && paneOpen[prevId] && isOpen
          return (
            <Fragment key={id}>
              {i > 0 && (
                <div
                  className={`pane-divider${dividerLive ? '' : ' static'}`}
                  onPointerDown={dividerLive ? onDividerPointerDown(prevId, id) : undefined}
                  onPointerMove={dividerLive ? onDividerPointerMove : undefined}
                  onPointerUp={dividerLive ? onDividerPointerUp : undefined}
                  onPointerLeave={dividerLive ? onDividerPointerUp : undefined}
                />
              )}
              <section
                className={`pane ${id}-pane${isOpen ? '' : ' pane-collapsed'}`}
                style={{
                  flexGrow: isOpen ? paneFlex[id] : 0,
                  flexShrink: isOpen ? 1 : 0,
                  flexBasis: isOpen ? '0%' : `${STRIP_WIDTH_PX}px`,
                  zIndex: i + 1,
                }}
              >
                {isOpen ? (
                  <>
                    <div className="pane-header">
                      <h2>{PANE_TITLE[id]}</h2>
                      <button className="pane-close-btn" onClick={() => setPaneOpen(id, false)} title="Collapse" aria-label="Collapse">
                        ×
                      </button>
                    </div>
                    {toolbar}
                    <div className="pane-body">{body}</div>
                  </>
                ) : (
                  <button className="pane-collapsed-tab" onClick={() => setPaneOpen(id, true)} title={`Expand ${PANE_TITLE[id]}`}>
                    <span className="pane-collapsed-label">{PANE_TITLE[id]}</span>
                  </button>
                )}
              </section>
            </Fragment>
          )
        })}
      </main>
    </div>
  )
}

export default App
