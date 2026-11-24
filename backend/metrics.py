import sqlite3
from datetime import datetime, timezone
from pathlib import Path


class MetricsDB:
    def __init__(self, path: str = "data/metrics.sqlite3") -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS llm_usage (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    time TEXT NOT NULL,
                    user TEXT NOT NULL,
                    model TEXT NOT NULL,
                    input INTEGER NOT NULL,
                    output INTEGER NOT NULL,
                    session_id TEXT,
                    provider TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS session_metrics (
                    session_id TEXT PRIMARY KEY,
                    user TEXT NOT NULL,
                    started_at TEXT,
                    ended_at TEXT,
                    turns_forward INTEGER NOT NULL DEFAULT 0,
                    turns_backward INTEGER NOT NULL DEFAULT 0
                );
                """
            )

    def connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def record_usage(self, user: str, model: str, input_tokens: int, output_tokens: int, session_id: str | None, provider: str) -> None:
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO llm_usage(time,user,model,input,output,session_id,provider) VALUES(?,?,?,?,?,?,?)",
                (datetime.now(timezone.utc).isoformat(), user, model, input_tokens, output_tokens, session_id, provider),
            )

    def start_session(self, session_id: str, user: str) -> None:
        with self.connection() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO session_metrics(session_id,user,started_at,turns_forward,turns_backward) VALUES(?,?,?,?,?)",
                (session_id, user, datetime.now(timezone.utc).isoformat(), 0, 0),
            )

    def record_forward(self, session_id: str, user: str) -> None:
        with self.connection() as connection:
            connection.execute(
                "UPDATE session_metrics SET turns_forward=turns_forward+1, user=? WHERE session_id=?",
                (user, session_id),
            )

    def record_backward(self, session_id: str) -> None:
        with self.connection() as connection:
            connection.execute("UPDATE session_metrics SET turns_backward=turns_backward+1 WHERE session_id=?", (session_id,))

    def finish_session(self, session_id: str) -> None:
        with self.connection() as connection:
            connection.execute("UPDATE session_metrics SET ended_at=? WHERE session_id=?", (datetime.now(timezone.utc).isoformat(), session_id))

    def usage(self) -> list[dict]:
        with self.connection() as connection:
            return [dict(row) for row in connection.execute("SELECT * FROM llm_usage ORDER BY time DESC").fetchall()]

    def sessions(self) -> list[dict]:
        with self.connection() as connection:
            rows = connection.execute(
                """
                SELECT s.session_id,s.user,s.started_at,s.ended_at,s.turns_forward,s.turns_backward,
                       COALESCE(SUM(u.input),0) AS input_tokens, COALESCE(SUM(u.output),0) AS output_tokens,
                       ROUND((julianday(COALESCE(s.ended_at, CURRENT_TIMESTAMP)) - julianday(s.started_at)) * 86400, 1) AS duration_seconds
                FROM session_metrics s LEFT JOIN llm_usage u ON u.session_id=s.session_id
                GROUP BY s.session_id ORDER BY s.started_at DESC
                """
            ).fetchall()
            return [dict(row) for row in rows]

