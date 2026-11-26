from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import app, extract_bullets
from backend.models import Turn


def test_resume_parser_preserves_grouped_source_bullets():
    resume = Path(__file__).parent / "resources" / "CarloResume.txt"
    entries = extract_bullets(resume.read_text())

    firmware = next(entry for entry in entries if entry.title == "Firmware Engineer I")
    assert firmware.organization == "NovaTech Embedded Solutions"
    assert firmware.dates == "June 2024 – Present"
    assert len(firmware.bullets) == 8
    assert "reducing RAM consumption" in firmware.bullets[4]


def test_coach_prefix_is_removed_from_turn_text():
    turn = Turn(role="agent", text="Here's a potential follow-up question: What did you own?")
    assert turn.text == "What did you own?"


def test_health_and_profile_flow(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.main.store.path", tmp_path / "store.json")
    monkeypatch.setattr("backend.main.store", __import__("backend.storage", fromlist=["JsonStore"]).JsonStore(str(tmp_path / "store.json")))
    client = TestClient(app)
    assert client.get("/api/health").json()["status"] == "ok"
    response = client.post("/api/profiles", json={"name": "Ada", "raw_text": "Built a distributed system that served 100 requests per second."})
    assert response.status_code == 200
    profile = response.json()
    assert profile["bullets"]
    plan = client.post(f"/api/profiles/{profile['id']}/plan")
    assert plan.status_code == 200
    session = plan.json()[0]
    started = client.post(f"/api/sessions/{session['id']}/start")
    assert started.status_code == 200
    assert started.json()["provider"] == "mock"
    answered = client.post(f"/api/sessions/{session['id']}/answer", json={"text": "I owned the service design and measured latency."})
    assert answered.status_code == 200
    assert answered.json()["provider"] == "mock"
    random_start = client.post(f"/api/profiles/{profile['id']}/coach/start")
    assert random_start.status_code == 200
    assert random_start.json()["provider"] == "mock"
    assert random_start.json()["selected_history"]["id"] in {bullet["id"] for bullet in profile["bullets"]}


def test_voice_is_opt_in_and_model_free_by_default():
    client = TestClient(app)
    status = client.get("/api/voice/status")
    assert status.status_code == 200
    assert status.json()["enabled"] is False
    assert status.json()["stt_loaded"] is False
    assert status.json()["tts_loaded"] is False
    assert client.post("/api/voice/transcribe", files={"file": ("sample.webm", b"not-audio", "audio/webm")}).status_code == 503
    assert client.post("/api/voice/synthesize", json={"text": "hello"}).status_code == 503

