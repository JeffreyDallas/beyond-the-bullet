import os


# Automated tests must never call Ollama or any paid/cloud model provider.
os.environ["MOCK_LLM"] = "1"
