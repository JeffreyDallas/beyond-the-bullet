import { execFileSync } from "node:child_process";

export default function globalTeardown() {
  execFileSync(".venv/bin/python", ["-m", "backend.cli", "delete-all-profiles", "--yes"], {
    cwd: "..",
    env: { ...process.env, BEYOND_BULLET_DATA_DIR: ".data/e2e" },
    stdio: "inherit",
  });
}
