import json
from pathlib import Path
from threading import Lock
from typing import Any


class JsonStore:
    """Small local store for the single-user localhost MVP."""

    def __init__(self, path: str = "data/store.json") -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = Lock()
        if not self.path.exists():
            self._write({"profiles": {}, "sessions": {}, "facts": {}})

    def _read(self) -> dict[str, Any]:
        return json.loads(self.path.read_text())

    def _write(self, value: dict[str, Any]) -> None:
        self.path.write_text(json.dumps(value, indent=2, default=str))

    def all(self) -> dict[str, Any]:
        with self.lock:
            return self._read()

    def put(self, collection: str, key: str, value: Any) -> None:
        with self.lock:
            state = self._read()
            state[collection][key] = value.model_dump(mode="json") if hasattr(value, "model_dump") else value
            self._write(state)

    def delete(self, collection: str, key: str) -> None:
        with self.lock:
            state = self._read()
            state[collection].pop(key, None)
            self._write(state)

    def clear_all(self) -> None:
        with self.lock:
            self._write({"profiles": {}, "sessions": {}, "facts": {}})

