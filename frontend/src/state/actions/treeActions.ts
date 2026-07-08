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

/**
 * Deletes a leaf outright, or a degree-2 node (exactly one child) by
 * splicing it out and merging its two adjacent edge lengths into one
 * (preserving the total tree distance across it) — but refuses to delete
 * any node with two or more children, per the user's "leaf or degree-2
 * only, never a branch" rule. Root is handled as a degree-{0,1} special
 * case (root has no parent edge to merge, only a child to promote).
 * Returns null for the disallowed (branch node) case.
 */
export function deleteNode(tree: TreeState, nodeId: string): { tree: TreeState; deletedId: string } | null {
  const node = tree.nodes[nodeId]
  if (!node) return null
  const isRoot = node.parentId === null

  if (node.children.length >= 2) return null

  if (isRoot) {
    if (node.children.length === 0) {
      return { tree: { rootId: null, nodes: {} }, deletedId: nodeId }
    }
    const childId = node.children[0]
    const child = tree.nodes[childId]
    const nodes = { ...tree.nodes }
    delete nodes[nodeId]
    nodes[childId] = { ...child, parentId: null, length: null }
    return { tree: { rootId: childId, nodes }, deletedId: nodeId }
  }

  const parent = tree.nodes[node.parentId!]
  const nodes = { ...tree.nodes }
  delete nodes[nodeId]

  if (node.children.length === 0) {
    nodes[node.parentId!] = { ...parent, children: parent.children.filter((id) => id !== nodeId) }
    return { tree: { ...tree, nodes }, deletedId: nodeId }
  }

  const childId = node.children[0]
  const child = tree.nodes[childId]
  const mergedLength = (node.length ?? 0) + (child.length ?? 0)
  nodes[node.parentId!] = {
    ...parent,
    children: parent.children.map((id) => (id === nodeId ? childId : id)),
  }
  nodes[childId] = { ...child, parentId: node.parentId, length: mergedLength }
  return { tree: { ...tree, nodes }, deletedId: nodeId }
}
