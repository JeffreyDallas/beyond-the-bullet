import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: { baseURL: "http://127.0.0.1:5173" },
  webServer: [
    { command: ".venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8000", cwd: "..", url: "http://127.0.0.1:8000/api/health", reuseExistingServer: true },
    { command: "npm --prefix frontend run dev -- --host 127.0.0.1 --port 5173", cwd: "..", url: "http://127.0.0.1:5173", reuseExistingServer: true },
  ],
});
