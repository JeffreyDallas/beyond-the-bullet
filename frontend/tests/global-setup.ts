import { execFileSync } from "node:child_process";

export default function globalSetup() {
  execFileSync(".venv/bin/python", ["-m", "backend.cli", "delete-all-profiles", "--yes"], {
    cwd: "..",
    stdio: "inherit",
  });
}
