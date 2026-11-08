import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

// Windows has no POSIX PTY; native Windows launchers have separate artifact checks.
it.runIf(process.platform === "linux" || process.platform === "darwin")(
  "exercises completion behavior through a real shell editor",
  () => {
    const shell = process.platform === "darwin" ? "zsh" : "bash";
    expect(() => execFileSync("python3", ["-u", "test/commands/completion/shell-module.py", "--shell", shell], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    })).not.toThrow();
  },
   130_000,
);
