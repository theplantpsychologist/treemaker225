export interface TreeNode {
  id: string
  parentId: string | null
  /** Edge length from this node's parent. Null only for the root. */
  length: number | null
  children: string[]
  x: number
  y: number
}

export interface TreeState {
  rootId: string | null
  nodes: Record<string, TreeNode>
}

/** Wire format sent to the backend: strips display-only x/y and derived children. */
export interface NodeIn {
  id: string
  parentId: string | null
  length: number | null
}

export interface TreeIn {
  rootId: string
  nodes: NodeIn[]
}

export function toTreeIn(tree: TreeState): TreeIn | null {
  if (!tree.rootId) return null
  return {
    rootId: tree.rootId,
    nodes: Object.values(tree.nodes).map((n) => ({
      id: n.id,
      parentId: n.parentId,
      length: n.length,
    })),
  }
}
