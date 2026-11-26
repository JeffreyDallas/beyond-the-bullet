# Beyond the Bullet

Local, resume-grounded interview practice for defending every line of your experience.

This repository currently implements MVP stages 1 and 2:

- local-only, no-login profile creation with resume text or TXT/PDF/DOCX upload
- editable parsed bullets and three focused interview rounds per bullet
- adaptive follow-up questions through Ollama when available, with an offline fallback
- persisted sessions, pause/resume, transcript-grounded feedback, approved Experience Vault facts, and a bullet dashboard API
- browser-friendly listen controls and voice-ready UI; full local STT/TTS remains optional

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm --prefix frontend install
npm --prefix frontend run build
uvicorn backend.main:app --reload
```

Open <http://127.0.0.1:8000>. The app stores local data in `data/store.json`, which is ignored by Git.

For local LLM questions, follow [docs/Llama-LLM-Local-Setup.md](docs/Llama-LLM-Local-Setup.md), install and run [Ollama](https://ollama.com), then pull a model:

```bash
ollama pull llama3.2:3b
```

Set `OLLAMA_URL` and `OLLAMA_MODEL` to use another local Ollama model. If Ollama is unavailable, the app uses clearly bounded deterministic prompts so the interface remains testable offline.

## Tests

```bash
pytest -q
npm --prefix frontend run build
```

Playwright tests can be added under `frontend/tests` and run with `npm --prefix frontend test` after starting the server.

To watch the complete Playwright suite in a browser, use `npm --prefix frontend run test:headed`. For a slower run that makes each browser action easier to follow, use `npm --prefix frontend run test:headed:slow` (500 ms between actions). You can choose another delay with `PW_SLOW_MO`, for example `PW_SLOW_MO=1000 npm --prefix frontend run test:headed`.

To record the slow headed run for later playback, use `npm --prefix frontend run test:headed:slow:video`. Playwright saves the recordings as `.webm` files under `frontend/test-results/`, one video per test. Open a `.webm` file in a browser or media player. To record a different run, set `PW_VIDEO=on`, for example `PW_VIDEO=on npm --prefix frontend run test:headed -- admin-dashboard.spec.ts`.

The Carlo resume upload E2E test runs with `npm --prefix frontend test`. Run the separate local admin dashboard with `uvicorn backend.admin:app --reload --port 8001`, then open <http://127.0.0.1:8001>. Usage is stored in `data/metrics.sqlite3` and includes LLM calls plus session duration and forward/backward conversation counts.

## Scope and privacy

The app is intentionally a localhost prototype: there is no login, hosted inference, analytics export, URL scraping, or public deployment. Resume/profile text is treated as untrusted candidate data; it is not used as system instructions. Delete a local profile from the profile menu when its data should be removed.

The default interview mode is text-only. Speech-to-text and text-to-speech are not enabled in the user flow. The Playwright suite covers the Carlo TXT resume plus the Daniel PDF and Melissa DOCX resumes, using a deterministic mock LLM and three candidate answers per interview.

Automated tests never spend model tokens: `tests/conftest.py` forces `MOCK_LLM=1` for unit tests, and the Playwright web servers use the same flag. The mock provider exercises API responses, session state transitions, transcript rendering, profile switching, parsing, metrics, and admin-agent reporting without calling Ollama or a paid model. Use the real Ollama model only for manual development runs.
