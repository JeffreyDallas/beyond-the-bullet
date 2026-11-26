import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/global-setup.ts",
  globalTeardown: "./tests/global-teardown.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    video: process.env.PW_VIDEO === "on" ? "on" : "off",
    launchOptions: {
      slowMo: Number(process.env.PW_SLOW_MO ?? 0),
    },
  },
  webServer: [
    { command: "BEYOND_BULLET_DATA_DIR=.data/e2e MOCK_LLM=1 .venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8000", cwd: "..", url: "http://127.0.0.1:8000/api/health", reuseExistingServer: false },
    { command: "npm --prefix frontend run dev -- --host 127.0.0.1 --port 5173", cwd: "..", url: "http://127.0.0.1:5173", reuseExistingServer: false },
    { command: "BEYOND_BULLET_DATA_DIR=.data/e2e MOCK_LLM=1 .venv/bin/uvicorn backend.admin:app --host 127.0.0.1 --port 8001", cwd: "..", url: "http://127.0.0.1:8001/api/admin/health", reuseExistingServer: false },
  ],
});
