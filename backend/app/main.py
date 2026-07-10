from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import health, snap, solve

app = FastAPI(title="treemaker225")

app.add_middleware(
    CORSMiddleware,
    # Vite's dev server falls back to the next free port (5174, 5175, ...)
    # whenever its default 5173 is already taken by another process --
    # matching against any localhost port keeps CORS working regardless of
    # which one it lands on, instead of silently failing preflight.
    allow_origin_regex=r"http://localhost:\d+",
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api")
app.include_router(solve.router, prefix="/api")
app.include_router(snap.router, prefix="/api")
