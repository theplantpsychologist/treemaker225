import { useEffect, useLayoutEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useAppStore } from '../../state/store'
import { colorForConstraint } from '../../constants/constraintColors'
import { useTreeEditorInteraction } from './useTreeEditorInteraction'
import { useViewBoxPanZoom } from '../../hooks/useViewBoxPanZoom'
import { TREE_NODE_RADIUS_PX } from '../../constants/sizeTokens'
import './TreeEditor.css'

export function TreeEditorCanvas() {
  const svgRef = useRef<SVGSVGElement>(null)
  const tree = useAppStore((s) => s.tree)
  const activeParentId = useAppStore((s) => s.activeParentId)
  const selectedEdgeId = useAppStore((s) => s.selectedEdgeId)
  const clearSelection = useAppStore((s) => s.clearSelection)
  const perLeaf = useAppStore((s) => s.constraints.perLeaf)
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
            className="tree-edge"
            x1={parent.x}
            y1={parent.y}
            x2={node.x}
            y2={node.y}
          />
        )
      })}

      {nodes.map((node) => {
        const isLeaf = !node.parentId ? false : node.children.length === 0
        const isActiveParent = node.id === activeParentId
        const isEdgeSelected = node.id === selectedEdgeId
        const style = isLeaf && !isActiveParent ? { fill: colorForConstraint(node.id, perLeaf[node.id]) } : undefined
        return (
          <circle
            key={node.id}
            className={
              'tree-node' +
              (isActiveParent ? ' selected' : '') +
              (isEdgeSelected ? ' edge-selected' : '') +
              (isLeaf ? ' leaf' : '')
            }
            style={style}
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
