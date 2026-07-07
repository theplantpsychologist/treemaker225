import Graph from 'graphology'
import { bidirectional } from 'graphology-shortest-path/dijkstra'
import type { TreeState } from '../types/tree'

export function buildTreeGraph(tree: TreeState): Graph {
  const graph = new Graph({ type: 'undirected' })
  for (const node of Object.values(tree.nodes)) {
    if (!graph.hasNode(node.id)) graph.addNode(node.id)
    if (node.parentId) {
      if (!graph.hasNode(node.parentId)) graph.addNode(node.parentId)
      graph.addEdge(node.parentId, node.id, { length: node.length ?? 0 })
    }
  }
  return graph
}

/** Sums every edge length along the tree path between two nodes. */
export function findDistance(graph: Graph, a: string, b: string): number {
  if (a === b) return 0
  const path = bidirectional(graph, a, b, 'length')
  if (!path) return Infinity
  let total = 0
  for (let i = 0; i < path.length - 1; i++) {
    total += graph.getEdgeAttribute(path[i], path[i + 1], 'length') as number
  }
  return total
}
