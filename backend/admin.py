from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from .metrics import MetricsDB


metrics = MetricsDB()
app = FastAPI(title="Beyond the Bullet Admin", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/admin/health")
async def health() -> dict:
    return {"status": "ok", "service": "admin"}


@app.get("/api/admin/usage")
async def usage() -> list[dict]:
    return metrics.usage()


@app.get("/api/admin/sessions")
async def sessions() -> list[dict]:
    return metrics.sessions()


@app.get("/api/admin/agent-performance")
async def agent_performance() -> dict:
    return metrics.agent_performance()


@app.get("/", response_class=HTMLResponse)
async def dashboard() -> str:
    return Path(__file__).parent.parent.joinpath("admin", "index.html").read_text()

