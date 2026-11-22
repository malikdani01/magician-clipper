"""Magician Clipper video-engine — FastAPI entrypoint (Phase 1)."""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.db import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()  # create jobs table on startup
    yield


app = FastAPI(
    title="Magician Clipper — Video Engine",
    description=(
        "Phase 1: real media probing (ffprobe) and audio extraction (ffmpeg) "
        "with a SQLite job ledger. Transcription, highlights, rendering and "
        "captions are Phase 3+."
    ),
    version="0.1.0",
    lifespan=lifespan,
)

# The browser calls the engine directly (health probe, probe, extract-audio),
# so it needs CORS for the frontend origins — the Vite dev server (:5173) and
# the Vite preview server (:4173). Override with ENGINE_CORS_ORIGINS.
ENGINE_CORS_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "ENGINE_CORS_ORIGINS",
        "http://localhost:4173,http://127.0.0.1:4173,"
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ENGINE_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.get("/")
def root() -> dict:
    return {"service": "video-engine", "version": "0.1.0", "phase": 1}
