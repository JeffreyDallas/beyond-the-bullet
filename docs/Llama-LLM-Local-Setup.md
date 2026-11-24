# Local Llama / Ollama setup

Beyond the Bullet is local-first. The backend sends question-generation prompts to Ollama when it is available and uses a deterministic fallback when it is not.

## Install Ollama

1. Install Ollama from [ollama.com/download](https://ollama.com/download) for macOS, Linux, or Windows.
2. Start the Ollama service. On macOS and Windows, launch the Ollama application. On Linux:

   ```bash
   ollama serve
   ```

3. Download a local Llama model:

   ```bash
   ollama pull llama3.2:3b
   ```

4. Verify the model:

   ```bash
   ollama run llama3.2:3b
   ```

   Type a short question, then exit with `Ctrl-D`.

## Run Beyond the Bullet with Llama

From the repository root:

```bash
source .venv/bin/activate
export OLLAMA_URL=http://localhost:11434
export OLLAMA_MODEL=llama3.2:3b
uvicorn backend.main:app --reload --port 8000
```

Open <http://127.0.0.1:8000>.

The default endpoint is `http://localhost:11434`. The model name can be changed to any model already installed locally, for example:

```bash
ollama list
export OLLAMA_MODEL=llama3.1:8b
```

## Hardware guidance

- `llama3.2:3b` is the recommended smoke-test model and needs less memory.
- Larger models usually produce stronger follow-up questions but require more RAM/VRAM and increase latency.
- Keep the model on the same machine as the backend for the intended localhost workflow.

## Troubleshooting

Check that Ollama is responding:

```bash
curl http://localhost:11434/api/tags
```

If the model is missing, run `ollama pull "$OLLAMA_MODEL"`.

If Ollama is stopped or unreachable, the app still runs and records `provider=fallback` in the metrics database. Fallback token counts are estimates based on whitespace tokens; Ollama calls record its prompt/evaluation counts when supplied by the API.

## Privacy

Resume text and interview answers are sent only to the locally running Ollama service in this setup. The local SQLite metrics database contains usage metadata, not a copy of the prompts or answers.
