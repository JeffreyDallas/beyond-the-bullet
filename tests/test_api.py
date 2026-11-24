from fastapi.testclient import TestClient

from backend.main import app


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
    answered = client.post(f"/api/sessions/{session['id']}/answer", json={"text": "I owned the service design and measured latency."})
    assert answered.status_code == 200

