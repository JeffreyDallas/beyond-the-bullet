import re
from io import BytesIO
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from docx import Document
from pypdf import PdfReader

from .llm import LocalLLM
from .metrics import MetricsDB
from .models import AnswerInput, FactInput, Profile, ProfileInput, ResumeBullet, Session, Turn, VaultFact
from .storage import JsonStore


store = JsonStore()
llm = LocalLLM()
metrics = MetricsDB()


def extract_bullets(text: str) -> list[ResumeBullet]:
    lines = [re.sub(r"^[\s•*-]+", "", line).strip() for line in text.splitlines()]
    candidates = [line for line in lines if len(line) >= 35]
    return [ResumeBullet(text=line, source="pasted/uploaded resume") for line in candidates[:12]]


def profile_or_404(profile_id: str) -> Profile:
    raw = store.all()["profiles"].get(profile_id)
    if not raw:
        raise HTTPException(404, "Profile not found")
    return Profile.model_validate(raw)


def session_or_404(session_id: str) -> Session:
    raw = store.all()["sessions"].get(session_id)
    if not raw:
        raise HTTPException(404, "Session not found")
    return Session.model_validate(raw)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield


app = FastAPI(title="Beyond the Bullet", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "llm": llm.model}


@app.get("/api/profiles")
async def list_profiles() -> list[Profile]:
    return [Profile.model_validate(item) for item in store.all()["profiles"].values()]


@app.post("/api/profiles")
async def create_profile(payload: ProfileInput) -> Profile:
    profile = Profile(name=payload.name.strip() or "Candidate", raw_text=payload.raw_text, bullets=extract_bullets(payload.raw_text))
    store.put("profiles", profile.id, profile)
    return profile


@app.get("/api/profiles/{profile_id}")
async def get_profile(profile_id: str) -> Profile:
    return profile_or_404(profile_id)


@app.patch("/api/profiles/{profile_id}")
async def update_profile(profile_id: str, payload: ProfileInput) -> Profile:
    profile = profile_or_404(profile_id)
    profile.name = payload.name.strip() or profile.name
    profile.raw_text = payload.raw_text
    profile.updated_at = datetime.utcnow()
    store.put("profiles", profile.id, profile)
    return profile


@app.delete("/api/profiles/{profile_id}")
async def delete_profile(profile_id: str) -> dict:
    profile_or_404(profile_id)
    store.delete("profiles", profile_id)
    state = store.all()
    for session_id, raw in list(state["sessions"].items()):
        if raw["profile_id"] == profile_id:
            store.delete("sessions", session_id)
    for fact_id, raw in list(store.all()["facts"].items()):
        if raw["profile_id"] == profile_id:
            store.delete("facts", fact_id)
    return {"deleted": profile_id}


@app.post("/api/resume/upload")
async def upload_resume(file: UploadFile = File(...)) -> dict:
    if file.content_type not in {"text/plain", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}:
        raise HTTPException(400, "Upload a TXT, PDF, or DOCX file")
    content = await file.read()
    if len(content) > 5_000_000:
        raise HTTPException(413, "Resume must be smaller than 5 MB")
    if file.content_type == "text/plain":
        return {"text": content.decode("utf-8", errors="replace")}
    if file.content_type == "application/pdf":
        return {"text": "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(content)).pages)}
    document = Document(BytesIO(content))
    return {"text": "\n".join(paragraph.text for paragraph in document.paragraphs if paragraph.text.strip())}


@app.post("/api/profiles/{profile_id}/plan")
async def create_plan(profile_id: str) -> list[Session]:
    profile = profile_or_404(profile_id)
    existing = [Session.model_validate(item) for item in store.all()["sessions"].values() if item["profile_id"] == profile_id]
    if existing:
        return existing
    sessions = [Session(profile_id=profile.id, bullet_id=bullet.id) for bullet in profile.bullets[:4]]
    for session in sessions:
        store.put("sessions", session.id, session)
    return sessions


@app.get("/api/profiles/{profile_id}/sessions")
async def list_sessions(profile_id: str) -> list[Session]:
    profile_or_404(profile_id)
    return [Session.model_validate(item) for item in store.all()["sessions"].values() if item["profile_id"] == profile_id]


@app.post("/api/sessions/{session_id}/start")
async def start_session(session_id: str) -> dict:
    session = session_or_404(session_id)
    profile = profile_or_404(session.profile_id)
    bullet = next((item for item in profile.bullets if item.id == session.bullet_id), None)
    if not bullet:
        raise HTTPException(404, "Bullet not found")
    prompt = f"Ask one concise first interview question about this resume bullet: {bullet.text}"
    fallback = f"Walk me through this experience in your own words. What did you personally own, and what changed because of your work?"
    question, provider, input_tokens, output_tokens = await llm.complete(prompt, fallback)
    metrics.record_usage(profile.name, llm.model, input_tokens, output_tokens, session.id, provider)
    metrics.start_session(session.id, profile.name)
    session.status = "active"
    session.current_round = 1
    session.turns = [Turn(role="agent", text=question, bullet_id=bullet.id)]
    session.updated_at = datetime.utcnow()
    store.put("sessions", session.id, session)
    return {"session": session, "provider": provider}


@app.post("/api/sessions/{session_id}/answer")
async def answer_session(session_id: str, payload: AnswerInput) -> dict:
    session = session_or_404(session_id)
    if session.status != "active":
        raise HTTPException(409, "Session is not active")
    answer = payload.text.strip()
    if not answer:
        raise HTTPException(400, "Answer cannot be empty")
    session.turns.append(Turn(role="user", text=answer, bullet_id=session.bullet_id))
    session.covered_topics.extend(topic for topic in ["personal ownership", "implementation detail", "impact"] if topic in answer.lower() and topic not in session.covered_topics)
    session.current_round += 1
    profile = profile_or_404(session.profile_id)
    bullet = next(item for item in profile.bullets if item.id == session.bullet_id)
    fallback_questions = [
        "What was the hardest technical tradeoff, and what alternatives did you consider?",
        "How did you measure the outcome, and what evidence supports the result?",
    ]
    fallback = fallback_questions[min(session.current_round - 2, len(fallback_questions) - 1)]
    prompt = f"Resume bullet: {bullet.text}\nPrevious answer: {answer}\nAsk a grounded follow-up question that probes one missing detail. Do not invent facts."
    question, provider, input_tokens, output_tokens = await llm.complete(prompt, fallback)
    metrics.record_usage(profile.name, llm.model, input_tokens, output_tokens, session.id, provider)
    metrics.record_forward(session.id, profile.name)
    if session.current_round > session.max_rounds:
        session.status = "complete"
        metrics.finish_session(session.id)
        session.feedback = {"strengths": ["Completed a focused explanation."], "gaps": ["Add concrete evidence and measurable impact where possible."], "next_step": "Approve useful facts to your Experience Vault and revisit the gaps."}
    else:
        session.turns.append(Turn(role="agent", text=question, bullet_id=bullet.id))
        session.unresolved_gaps = ["specific evidence", "tradeoff or constraint"]
    session.updated_at = datetime.utcnow()
    store.put("sessions", session.id, session)
    return {"session": session, "provider": provider}


@app.post("/api/sessions/{session_id}/pause")
async def pause_session(session_id: str) -> Session:
    session = session_or_404(session_id)
    session.status = "paused"
    store.put("sessions", session.id, session)
    return session


@app.get("/api/profiles/{profile_id}/facts")
async def list_facts(profile_id: str) -> list[VaultFact]:
    profile_or_404(profile_id)
    return [VaultFact.model_validate(item) for item in store.all()["facts"].values() if item["profile_id"] == profile_id]


@app.post("/api/profiles/{profile_id}/facts")
async def add_fact(profile_id: str, payload: FactInput) -> VaultFact:
    profile_or_404(profile_id)
    fact = VaultFact(profile_id=profile_id, text=payload.text, source_turn_id=payload.source_turn_id, approved=True)
    store.put("facts", fact.id, fact)
    return fact


@app.get("/api/profiles/{profile_id}/dashboard")
async def dashboard(profile_id: str) -> dict:
    profile = profile_or_404(profile_id)
    sessions = await list_sessions(profile_id)
    facts = await list_facts(profile_id)
    return {"bullets": [{"id": b.id, "text": b.text, "status": next((s.status for s in sessions if s.bullet_id == b.id), "unplanned"), "practice_count": sum(1 for s in sessions if s.bullet_id == b.id)} for b in profile.bullets], "facts": facts, "sessions": sessions}


frontend_dir = Path(__file__).parent.parent / "frontend"
assets_dir = frontend_dir / "assets"
if assets_dir.exists():
    app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(frontend_dir / "index.html")

