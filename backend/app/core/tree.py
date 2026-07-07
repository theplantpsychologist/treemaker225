from typing import List

import networkx as nx

from app.schemas.tree import TreeIn


def build_tree(tree_in: TreeIn) -> nx.DiGraph:
    graph: nx.DiGraph = nx.DiGraph()
    for node in tree_in.nodes:
        graph.add_node(node.id)
    for node in tree_in.nodes:
        if node.parent_id is not None:
            graph.add_edge(node.parent_id, node.id, length=node.length)

    if graph.number_of_nodes() == 0 or not nx.is_arborescence(graph):
        raise ValueError("tree must be a single connected tree with exactly one root")

    return graph


def get_leaves(tree: nx.DiGraph) -> List[str]:
    return [n for n in tree.nodes if tree.out_degree(n) == 0]


def find_distance(tree: nx.DiGraph, a: str, b: str) -> float:
    """Sums every edge length along the tree path between two nodes."""
    if a == b:
        return 0.0
    undirected = tree.to_undirected(as_view=True)
    return nx.shortest_path_length(undirected, a, b, weight="length")


def total_edge_length(tree: nx.DiGraph) -> float:
    return sum(length for _, _, length in tree.edges(data="length"))
