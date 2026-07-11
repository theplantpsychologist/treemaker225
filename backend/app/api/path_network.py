from fastapi import APIRouter, HTTPException

from app.schemas.path_network import PathNetworkRequest, PathNetworkResponse
from app.services.path_network_service import solve_path_network

router = APIRouter()


@router.post("/path-network-snap", response_model=PathNetworkResponse)
def path_network_snap_endpoint(req: PathNetworkRequest) -> PathNetworkResponse:
    try:
        return solve_path_network(req)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
