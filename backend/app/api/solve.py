from fastapi import APIRouter, HTTPException

from app.schemas.solve import SolveRequest, SolveResponse
from app.services.solve_service import solve

router = APIRouter()


@router.post("/solve", response_model=SolveResponse)
def solve_endpoint(req: SolveRequest) -> SolveResponse:
    try:
        return solve(req)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
