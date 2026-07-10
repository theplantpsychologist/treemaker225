from fastapi import APIRouter, HTTPException

from app.schemas.snap import SnapPathsRequest, SnapPathsResponse
from app.services.snap_service import snap_active_paths

router = APIRouter()


@router.post("/snap-paths", response_model=SnapPathsResponse)
def snap_paths_endpoint(req: SnapPathsRequest) -> SnapPathsResponse:
    try:
        return snap_active_paths(req)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
