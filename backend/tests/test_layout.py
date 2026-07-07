from app.core.layout import solve_internal_layout
from app.core.tree import build_tree
from app.schemas.tree import NodeIn, TreeIn


def test_internal_layout_places_branch_between_its_leaves():
    tree_in = TreeIn(
        root_id="root",
        nodes=[
            NodeIn(id="root", parent_id=None, length=None),
            NodeIn(id="branch", parent_id="root", length=2.0),
            NodeIn(id="leaf_a", parent_id="branch", length=1.0),
            NodeIn(id="leaf_b", parent_id="branch", length=1.0),
        ],
    )
    tree = build_tree(tree_in)
    leaf_positions = {"leaf_a": (0.1, 0.5), "leaf_b": (0.9, 0.5)}
    scale = 0.1

    positions = solve_internal_layout(tree, leaf_positions, scale)

    assert set(positions.keys()) == {"root", "branch"}
    # branch should end up roughly between the two leaves it connects to.
    bx, by = positions["branch"]
    assert 0.0 <= bx <= 1.0
    assert abs(by - 0.5) < 0.2
