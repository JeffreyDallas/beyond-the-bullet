import json
import logging
import re
import time
from io import BytesIO
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from docx import Document
from pypdf import PdfReader

from .llm import LocalLLM
from .metrics import MetricsDB
from .models import AnswerInput, FactInput, Profile, ProfileInput, ResumeBullet, Session, VaultFact
from .orchestrator import continue_coach_session, start_coach_session, start_random_session
from .storage import JsonStore
from .voice import LocalSpeechService, VoiceNotConfigured


store = JsonStore()
llm = LocalLLM()
metrics = MetricsDB()
speech = LocalSpeechService()
logger = logging.getLogger("beyond_the_bullet.coach")


def extract_bullets(text: str) -> list[ResumeBullet]:
    """Parse explicit resume headings without inventing missing history."""
    raw_lines = [line.strip() for line in text.splitlines()]
    lines = [re.sub(r"^[\s•*\-]+", "", line).strip() for line in raw_lines]
    entries: list[ResumeBullet] = []
    section = ""
    section_names = {
        "professional experience": "experience",
        "work experience": "experience",
        "experience": "experience",
        "education": "education",
        "academic projects": "project",
        "projects": "project",
    }
    date_pattern = re.compile(r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[ .]+\d{4}|\b\d{4}\b", re.I)

    def clean(value: str) -> str:
        return re.sub(r"[*_`]+", "", value).strip(" |-:")

    def metadata(value: str, following: str = "") -> tuple[str, str, str]:
        parts = [clean(part) for part in value.split("|") if clean(part)]
        dates = clean(following) if following and date_pattern.search(following) else ""
        if len(parts) >= 3:
            return parts[0], parts[1], parts[2]
        if len(parts) == 2:
            return parts[0], parts[1], dates
        return (parts[0] if parts else ""), "", dates

    def add_entry(
        title: str,
        metadata_line: str = "",
        dates_line: str = "",
        category: str = "experience",
        details: list[str] | None = None,
    ) -> None:
        organization, location, dates = metadata(metadata_line, dates_line)
        if not title:
            return
        summary = " — ".join(value for value in [title, organization] if value)
        if dates:
            summary = f"{summary} · {dates}"
        entries.append(
            ResumeBullet(
                text=summary,
                title=title,
                organization=organization,
                location=location,
                dates=dates,
                bullets=details or [],
                category=category,
                source="parsed resume history",
            )
        )

    index = 0
    while index < len(lines):
        line = lines[index]
        normalized = re.sub(r"^#+\s*", "", line).strip().lower().rstrip(":")
        if normalized in section_names or normalized.startswith("professional experience"):
            section = section_names.get("professional experience" if normalized.startswith("professional experience") else normalized, "")
            index += 1
            continue
        if raw_lines[index].startswith("#") and not raw_lines[index].startswith("###"):
            section = ""
            index += 1
            continue
        if not section:
            index += 1
            continue
        title = clean(re.sub(r"^###\s*", "", line)) if raw_lines[index].startswith("###") else ""
        metadata_line = ""
        dates_line = ""
        details: list[str] = []
        if title and index + 1 < len(lines):
            metadata_line = lines[index + 1]
            if index + 2 < len(lines) and date_pattern.search(lines[index + 2]):
                dates_line = lines[index + 2]
        elif index + 1 < len(lines) and "|" in lines[index + 1] and date_pattern.search(lines[index + 1]):
            title = clean(line)
            metadata_line = lines[index + 1]
        if title and not title.startswith("-") and len(title) > 2:
            next_index = index + (3 if dates_line else 2)
            while next_index < len(lines):
                candidate = lines[next_index]
                candidate_raw = raw_lines[next_index]
                candidate_normalized = re.sub(r"^#+\s*", "", candidate).strip().lower().rstrip(":")
                if candidate_normalized in section_names or candidate_normalized.startswith("professional experience") or candidate_raw.startswith("#"):
                    break
                if candidate and not candidate.startswith("#"):
                    details.append(clean(candidate))
                next_index += 1
            add_entry(title, metadata_line, dates_line, section, details)
            index = next_index
            continue
        index += 1
    if entries:
        return entries[:16]
    lines = [line for line in lines if len(line) >= 35]
    return [ResumeBullet(text=line, bullets=[line], source="pasted/uploaded resume") for line in lines[:12]]


def _json_array(text: str) -> list[dict] | None:
    match = re.search(r"\[[\s\S]*\]", text)
    if not match:
        return None
    try:
        value = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, list) and all(isinstance(item, dict) for item in value) else None


async def parse_resume_history(text: str) -> tuple[list[ResumeBullet], str, int, int]:
    fallback = extract_bullets(text)
    prompt = f"""Extract the candidate's explicit work experience, education, and projects from the resume text below.
Return ONLY a JSON array. Each object must have: title, organization, location, dates, category, bullets.
The bullets field must contain the source-backed accomplishment or responsibility bullets for that section.
Use only facts explicitly present in the resume. Do not infer employers, dates, titles, metrics, technologies, or achievements.
If a field is not stated, use an empty string or empty array. Do not interpret images and do not add commentary.

<resume_text>
{text}
</resume_text>"""
    response, provider, input_tokens, output_tokens = await llm.complete(prompt, "[]")
    parsed = _json_array(response)
    if not parsed:
        return fallback, provider, input_tokens, output_tokens
    entries: list[ResumeBullet] = []
    for item in parsed:
        title = str(item.get("title", "")).strip()
        if not title:
            continue
        bullets = item.get("bullets", [])
        if not isinstance(bullets, list):
            bullets = []
        entries.append(
            ResumeBullet(
                title=title,
                organization=str(item.get("organization", "")).strip(),
                location=str(item.get("location", "")).strip(),
                dates=str(item.get("dates", "")).strip(),
                bullets=[str(value).strip() for value in bullets if str(value).strip()],
                category=str(item.get("category", "experience")).strip() or "experience",
                text=" — ".join(value for value in [title, str(item.get("organization", "")).strip()] if value),
                source="LLM-parsed resume history",
            )
        )
    return (entries or fallback), provider, input_tokens, output_tokens


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


def record_agent_activity(session: Session, profile: Profile, bullet: ResumeBullet, question: str, follow_up: bool) -> None:
    bullet_terms = set(re.findall(r"[a-z]{4,}", bullet.text.lower()))
    question_terms = set(re.findall(r"[a-z]{4,}", question.lower()))
    overlap = len(bullet_terms & question_terms)
    relevance = min(1.0, overlap / 3.0)
    deep_dive = bool(re.search(r"\b(tradeoff|constraint|evidence|validate|measure|failure|alternative|personally)\b", question.lower()))
    notes = "Question overlaps the selected bullet." if relevance >= 0.33 else "Question has low lexical overlap; review grounding."
    metrics.record_agent_activity(session.id, profile.name, question, relevance, follow_up, deep_dive, notes)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield


app = FastAPI(title="Beyond the Bullet", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "llm": llm.model}


@app.get("/api/voice/status")
async def voice_status() -> dict:
    return speech.status().__dict__


@app.post("/api/voice/transcribe")
async def transcribe_voice(file: UploadFile = File(...)) -> dict:
    try:
        return speech.transcribe(await file.read())
    except VoiceNotConfigured as error:
        raise HTTPException(503, str(error)) from error


@app.post("/api/voice/synthesize")
async def synthesize_voice(payload: dict[str, str]) -> Response:
    text = payload.get("text", "").strip()
    if not text:
        raise HTTPException(400, "Text cannot be empty")
    try:
        audio = speech.synthesize(text)
    except VoiceNotConfigured as error:
        raise HTTPException(503, str(error)) from error
    return Response(content=audio, media_type="audio/wav")


@app.get("/api/profiles")
async def list_profiles() -> list[Profile]:
    return [Profile.model_validate(item) for item in store.all()["profiles"].values()]


@app.post("/api/profiles")
async def create_profile(payload: ProfileInput) -> Profile:
    bullets, _, _, _ = await parse_resume_history(payload.raw_text)
    profile = Profile(name=payload.name.strip() or "Candidate", raw_text=payload.raw_text, bullets=bullets)
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


@app.post("/api/profiles/{profile_id}/coach/start")
async def start_random_coach_session(profile_id: str) -> dict:
    profile = profile_or_404(profile_id)
    if not profile.bullets:
        raise HTTPException(400, "Profile has no resume history items to explore")
    result = await start_random_session(profile, llm)
    session = result["session"]
    bullet = next(item for item in profile.bullets if item.id == session.bullet_id)
    metrics.record_usage(profile.name, llm.model, result["input_tokens"], result["output_tokens"], session.id, result["provider"])
    metrics.start_session(session.id, profile.name)
    record_agent_activity(session, profile, bullet, result["question"], follow_up=False)
    store.put("sessions", session.id, session)
    return {"session": session, "provider": result["provider"], "selected_history": bullet}


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
    started_at = time.perf_counter()
    logger.info("coach_request session=%s round=%s prompt_history=%s", session.id, session.current_round + 1, len(session.turns))
    result = await start_coach_session(profile, session, llm)
    question = result["question"]
    provider = result["provider"]
    logger.info("coach_response session=%s provider=%s output_chars=%s duration_ms=%s", session.id, provider, len(question), round((time.perf_counter() - started_at) * 1000))
    metrics.record_usage(profile.name, llm.model, result["input_tokens"], result["output_tokens"], session.id, provider)
    metrics.start_session(session.id, profile.name)
    record_agent_activity(session, profile, bullet, question, follow_up=False)
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
    profile = profile_or_404(session.profile_id)
    started_at = time.perf_counter()
    logger.info("coach_followup_request session=%s round=%s answer_chars=%s", session.id, session.current_round, len(answer))
    result = await continue_coach_session(profile, session, answer, llm)
    question = result["question"]
    provider = result["provider"]
    logger.info("coach_followup_response session=%s provider=%s output_chars=%s duration_ms=%s status=%s", session.id, provider, len(question), round((time.perf_counter() - started_at) * 1000), session.status)
    metrics.record_usage(profile.name, llm.model, result["input_tokens"], result["output_tokens"], session.id, provider)
    metrics.record_forward(session.id, profile.name)
    if session.status == "complete":
        metrics.finish_session(session.id)
    else:
        bullet = next(item for item in profile.bullets if item.id == session.bullet_id)
        record_agent_activity(session, profile, bullet, question, follow_up=True)
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
frontend_dist = frontend_dir / "dist"
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
else:
    @app.get("/", response_class=HTMLResponse)
    async def frontend_not_built() -> str:
        return (
            "<h1>Beyond the Bullet frontend is not built</h1>"
            "<p>Run <code>npm --prefix frontend install</code> and "
            "<code>npm --prefix frontend run build</code>, then reload this page.</p>"
        )

