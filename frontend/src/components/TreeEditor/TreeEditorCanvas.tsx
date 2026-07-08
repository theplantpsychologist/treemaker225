import { useEffect, useLayoutEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useAppStore } from '../../state/store'
import { distanceToSegment } from '../../geometry/treeGeometry'
import { useTreeEditorInteraction } from './useTreeEditorInteraction'
import { useViewBoxPanZoom } from '../../hooks/useViewBoxPanZoom'
import { EDGE_HIT_TOLERANCE_MIN_PX, TREE_NODE_RADIUS_PX } from '../../constants/sizeTokens'
import './TreeEditor.css'

export function TreeEditorCanvas() {
  const svgRef = useRef<SVGSVGElement>(null)
  const tree = useAppStore((s) => s.tree)
  const activeParentId = useAppStore((s) => s.activeParentId)
  const selectedEdgeId = useAppStore((s) => s.selectedEdgeId)
  const clearSelection = useAppStore((s) => s.clearSelection)
  const selectEdge = useAppStore((s) => s.selectEdge)
  const createRootAt = useAppStore((s) => s.createRootAt)
  const addChildAt = useAppStore((s) => s.addChildAt)
  const deleteActiveNode = useAppStore((s) => s.deleteActiveNode)
  const { onNodePointerDown, onPointerMove, onPointerUp } = useTreeEditorInteraction(svgRef)
  const pan = useViewBoxPanZoom(svgRef, { x: 0, y: 0, w: 800, h: 600 })

  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    pan.initializeBase(rect.width, rect.height)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isTyping = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      if (isTyping) return
      if (e.key === 'Escape') clearSelection()
      else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        deleteActiveNode()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [clearSelection, deleteActiveNode])

  const onBackgroundPointerDown = (e: ReactPointerEvent<SVGRectElement>) => {
    // A click close enough to an edge selects it (for the Inspector / cross-
    // canvas highlighting) instead of panning or creating a new child —
    // checked here, before `pan.beginPan`, so `pan.endPan()` never reports
    // 'click' for an edge hit and the "empty click -> add child" branch in
    // `onSvgPointerUp` is naturally skipped.
    const p = pan.toWorldPoint(e)
    const tolerance = EDGE_HIT_TOLERANCE_MIN_PX * pan.pxToWorld
    let hitEdgeId: string | null = null
    let hitDist = tolerance
    for (const node of Object.values(tree.nodes)) {
      if (!node.parentId) continue
      const parent = tree.nodes[node.parentId]
      const d = distanceToSegment(p, parent, node)
      if (d <= hitDist) {
        hitDist = d
        hitEdgeId = node.id
      }
    }
    if (hitEdgeId) {
      selectEdge(hitEdgeId)
      return
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // best-effort
    }
    pan.beginPan(e)
  }
  const onSvgPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    onPointerMove(e)
    pan.onPanMove(e)
  }
  const onSvgPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    onPointerUp()
    if (pan.endPan() === 'click') {
      const p = pan.toWorldPoint(e)
      if (!tree.rootId) {
        createRootAt(p.x, p.y)
      } else if (activeParentId) {
        addChildAt(activeParentId, p.x, p.y)
      }
    }
  }

  const nodes = Object.values(tree.nodes)
  const nodeRadius = TREE_NODE_RADIUS_PX * pan.pxToWorld

  return (
    <svg
      ref={svgRef}
      className="tree-editor-canvas"
      viewBox={pan.viewBoxAttr}
      onPointerMove={onSvgPointerMove}
      onPointerUp={onSvgPointerUp}
      onPointerLeave={onSvgPointerUp}
    >
      <rect
        className="tree-editor-bg"
        x={pan.viewBox.x}
        y={pan.viewBox.y}
        width={pan.viewBox.w}
        height={pan.viewBox.h}
        onPointerDown={onBackgroundPointerDown}
      />

      {nodes.length === 0 && (
        <text className="empty-hint" x="50%" y="50%">
          Click anywhere to place the root node
        </text>
      )}

      {nodes.map((node) => {
        if (!node.parentId) return null
        const parent = tree.nodes[node.parentId]
        return (
          <line
            key={`edge-${node.id}`}
            className={'tree-edge' + (node.id === selectedEdgeId ? ' selected' : '')}
            x1={parent.x}
            y1={parent.y}
            x2={node.x}
            y2={node.y}
            onPointerDown={(e) => {
              e.stopPropagation()
              selectEdge(node.id)
            }}
          />
        )
      })}

      {nodes.map((node) => {
        const isLeaf = !node.parentId ? false : node.children.length === 0
        const isActiveParent = node.id === activeParentId
        const isEdgeSelected = node.id === selectedEdgeId
        return (
          <circle
            key={node.id}
            className={
              'tree-node' +
              (isActiveParent ? ' selected' : '') +
              (isEdgeSelected ? ' edge-selected' : '') +
              (isLeaf ? ' leaf' : '')
            }
            cx={node.x}
            cy={node.y}
            r={nodeRadius}
            onPointerDown={(e) => onNodePointerDown(node.id, e)}
          />
        )
      })}
    </svg>
  )
}
