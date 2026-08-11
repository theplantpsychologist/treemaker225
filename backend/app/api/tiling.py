from fastapi import APIRouter, HTTPException

from app.schemas.tiling import TilingRequest, TilingResponse
from app.services.tiling_service import solve_tiling_request

router = APIRouter()


@router.post("/tiling-snap", response_model=TilingResponse)
def tiling_snap_endpoint(req: TilingRequest) -> TilingResponse:
    try:
        return solve_tiling_request(req)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
