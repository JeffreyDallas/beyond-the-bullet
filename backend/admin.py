from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from .metrics import MetricsDB
from .storage import JsonStore


metrics = MetricsDB()
store = JsonStore()
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


def user_summary_rows() -> list[dict]:
    session_rows = metrics.sessions()
    profiles = list(store.all()["profiles"].values())
    names = {profile["name"] for profile in profiles} | {row["user"] for row in session_rows}
    rows = []
    for name in sorted(names):
        user_sessions = [row for row in session_rows if row["user"] == name]
        matching_profiles = [profile for profile in profiles if profile["name"] == name]
        bullet_count = sum(len(profile.get("bullets", [])) for profile in matching_profiles)
        completed = sum(row.get("ended_at") is not None for row in user_sessions)
        rows.append({
            "user": name,
            "profile_count": len(matching_profiles),
            "session_count": len(user_sessions),
            "completed_sessions": completed,
            "bullet_count": bullet_count,
            "progress_percent": round((completed / bullet_count) * 100) if bullet_count else 0,
            "input_tokens": sum(row["input_tokens"] for row in user_sessions),
            "output_tokens": sum(row["output_tokens"] for row in user_sessions),
        })
    return rows


@app.get("/api/admin/users")
async def users() -> list[dict]:
    return user_summary_rows()


@app.get("/api/admin/users/{user_name:path}")
async def user_detail(user_name: str) -> dict:
    summary = next((row for row in user_summary_rows() if row["user"] == user_name), None)
    if summary is None:
        return {"user": user_name, "sessions": [], "conversations": []}
    session_rows = [row for row in metrics.sessions() if row["user"] == user_name]
    matching_profile_ids = {profile["id"] for profile in store.all()["profiles"].values() if profile["name"] == user_name}
    session_ids = {row["session_id"] for row in session_rows}
    conversation_rows = [row for row in await conversations() if row["session_id"] in session_ids or row["user"] in matching_profile_ids]
    return {"summary": summary, "sessions": session_rows, "conversations": conversation_rows}


@app.get("/api/admin/agent-performance")
async def agent_performance() -> dict:
    return metrics.agent_performance()


@app.get("/api/admin/conversations")
async def conversations() -> list[dict]:
    records = []
    for session in store.all()["sessions"].values():
        for index, turn in enumerate(session.get("turns", []), start=1):
            records.append({
                "session_id": session["id"],
                "user": session["profile_id"],
                "status": session["status"],
                "turn_number": index,
                "role": turn["role"],
                "text": turn["text"],
                "created_at": turn.get("created_at", ""),
            })
    return records


@app.get("/", response_class=HTMLResponse)
async def dashboard() -> str:
    return Path(__file__).parent.parent.joinpath("admin", "index.html").read_text()

