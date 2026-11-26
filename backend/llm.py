import os
import re
from typing import Any

import httpx


class LocalLLM:
    """Ollama adapter with a predictable local fallback for offline development."""

    def __init__(self) -> None:
        self.base_url = os.getenv("OLLAMA_URL", "http://localhost:11434")
        self.model = os.getenv("OLLAMA_MODEL", "llama3.2:3b")
        self.mock = os.getenv("MOCK_LLM") == "1"

    async def complete(self, prompt: str, fallback: str) -> tuple[str, str, int, int]:
        if self.mock:
            if "Conversation so far:" in prompt and prompt.count("\nuser:") >= 3:
                return "DONE", "mock", max(1, len(prompt.split())), 1
            mock_question = fallback if "Previous answer" not in prompt else "What tradeoff or constraint shaped that implementation, and what evidence shows the outcome?"
            return self.clean_coach_text(mock_question), "mock", max(1, len(prompt.split())), max(1, len(mock_question.split()))
        try:
            async with httpx.AsyncClient(timeout=25) as client:
                response = await client.post(
                    f"{self.base_url}/api/generate",
                    json={"model": self.model, "prompt": prompt, "stream": False},
                )
                response.raise_for_status()
                answer: Any = response.json().get("response")
                if answer:
                    cleaned = self.clean_coach_text(str(answer))
                    return cleaned, "ollama", int(response.json().get("prompt_eval_count", 0)), int(response.json().get("eval_count", 0))
        except (httpx.HTTPError, ValueError):
            pass
        estimate = lambda value: max(1, int(len(value.split()) * 1.3))
        return self.clean_coach_text(fallback), "fallback", estimate(prompt), estimate(fallback)

    @staticmethod
    def clean_coach_text(text: str) -> str:
        """Remove a model's meta lead-in before displaying coach dialogue."""
        return re.sub(r"\bHere['’]s a potential follow-up question:\s*", "", text, flags=re.IGNORECASE).strip()

