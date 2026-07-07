from typing import List, Optional

from app.schemas.common import CamelModel


class NodeIn(CamelModel):
    id: str
    parent_id: Optional[str] = None
    length: Optional[float] = None


class TreeIn(CamelModel):
    root_id: str
    nodes: List[NodeIn]
