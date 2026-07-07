from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import health, solve

app = FastAPI(title="treemaker225")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api")
app.include_router(solve.router, prefix="/api")
