import { nanoid } from 'nanoid'
import type { TreeNode, TreeState } from '../../types/tree'
import { collectSubtreeIds, distance } from '../../geometry/treeGeometry'

export function createRootNode(x: number, y: number): TreeState {
  const id = nanoid()
  const node: TreeNode = { id, parentId: null, length: null, children: [], x, y }
  return { rootId: id, nodes: { [id]: node } }
}

export function addChildNode(
  tree: TreeState,
  parentId: string,
  x: number,
  y: number,
): { tree: TreeState; newId: string } {
  const parent = tree.nodes[parentId]
  const id = nanoid()
  const length = Math.max(distance(parent, { x, y }), 1e-6)
  const newNode: TreeNode = { id, parentId, length, children: [], x, y }
  const nodes = {
    ...tree.nodes,
    [parentId]: { ...parent, children: [...parent.children, id] },
    [id]: newNode,
  }
  return { tree: { ...tree, nodes }, newId: id }
}

/**
 * Rigidly translates nodeId and its entire subtree so nodeId lands at
 * (newX, newY), preserving every descendant edge's length and angle. Only
 * the single edge from nodeId to its own parent changes length/angle.
 */
export function dragNodeTo(tree: TreeState, nodeId: string, newX: number, newY: number): TreeState {
  const node = tree.nodes[nodeId]
  const dx = newX - node.x
  const dy = newY - node.y
  const subtreeIds = collectSubtreeIds(tree, nodeId)
  const nodes = { ...tree.nodes }
  for (const id of subtreeIds) {
    const n = nodes[id]
    nodes[id] = { ...n, x: n.x + dx, y: n.y + dy }
  }
  if (node.parentId) {
    const parent = nodes[node.parentId]
    const moved = nodes[nodeId]
    nodes[nodeId] = { ...moved, length: Math.max(distance(parent, moved), 1e-6) }
  }
  return { ...tree, nodes }
}

/**
 * Sets nodeId's edge length by recomputing its position at the new length
 * along its existing angle from its parent, then rigidly translating it (and
 * its subtree) there. This is the single authoritative "geometry changed"
 * path shared by tree-canvas drags and packing-canvas resize handles.
 */
export function setEdgeLength(tree: TreeState, nodeId: string, newLength: number): TreeState {
  const node = tree.nodes[nodeId]
  if (!node.parentId) return tree
  const parent = tree.nodes[node.parentId]
  const angle = Math.atan2(node.y - parent.y, node.x - parent.x)
  const length = Math.max(newLength, 1e-6)
  const newX = parent.x + length * Math.cos(angle)
  const newY = parent.y + length * Math.sin(angle)
  return dragNodeTo(tree, nodeId, newX, newY)
}
