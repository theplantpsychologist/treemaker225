import { useEffect, useRef } from 'react'
import { useAppStore } from '../../state/store'
import { colorForConstraint } from '../../constants/constraintColors'
import { useTreeEditorInteraction } from './useTreeEditorInteraction'
import './TreeEditor.css'

const NODE_RADIUS = 7

export function TreeEditorCanvas() {
  const svgRef = useRef<SVGSVGElement>(null)
  const tree = useAppStore((s) => s.tree)
  const selectedNodeId = useAppStore((s) => s.selectedNodeId)
  const selectNode = useAppStore((s) => s.selectNode)
  const perLeaf = useAppStore((s) => s.constraints.perLeaf)
  const { onNodePointerDown, onPointerMove, onPointerUp, onBackgroundPointerDown } =
    useTreeEditorInteraction(svgRef)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') selectNode(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectNode])

  const nodes = Object.values(tree.nodes)

  return (
    <svg
      ref={svgRef}
      className="tree-editor-canvas"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <rect
        className="tree-editor-bg"
        x={0}
        y={0}
        width="100%"
        height="100%"
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
        if (!node.parentId) return null
        const parent = tree.nodes[node.parentId]
        return (
          <text
            key={`label-${node.id}`}
            className="tree-edge-label"
            x={(parent.x + node.x) / 2}
            y={(parent.y + node.y) / 2}
          >
            {node.length!.toFixed(1)}
          </text>
        )
      })}

      {nodes.map((node) => {
        const isLeaf = node.children.length === 0
        const isSelected = node.id === selectedNodeId
        const style = isLeaf && !isSelected ? { fill: colorForConstraint(node.id, perLeaf[node.id]) } : undefined
        return (
          <circle
            key={node.id}
            className={'tree-node' + (isSelected ? ' selected' : '') + (isLeaf ? ' leaf' : '')}
            style={style}
            cx={node.x}
            cy={node.y}
            r={NODE_RADIUS}
            onPointerDown={(e) => onNodePointerDown(node.id, e)}
          />
        )
      })}
    </svg>
  )
}
