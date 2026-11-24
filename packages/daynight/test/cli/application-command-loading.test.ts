import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createCommandLoadingFixture, reviewRuntime } from "./command-loading-fixture.js";

describe("built executable command loading", () => {
  it("loads command and operation modules only when their behavior is selected", async () => {
    const { home, invoke, cleanup } = await createCommandLoadingFixture();
    const cases = [
      { args: [], blocked: ["/commands/"] },
      { args: ["--help"], blocked: ["/commands/"] },
      { args: ["--version"], blocked: ["/commands/"] },
      ...[["--skill"]].map((args) => ({
        args, blocked: ["which", "better-sqlite3", "yaml", "/platform/skill-bundle.js", "/commands/skill/skills/", "/commands/skill/agents.js", "/commands/skill/install.js", "/commands/skill/targets.js", "/commands/review/", "/config/", "/repository/", "/api/"],
      })),
      ...[["--help"], ["send", "--help"], ["operation", "--help"]].map(args => ({
        args: ["task", "session", ...args], blocked: ["/commands/task/session/send.js", "/commands/task/session/input.js", "/commands/task/session/operation-store.js", "/commands/task/session/private-files.js", "/commands/task/session/windows-files.js", "/commands/task/session/output.js", "koffi", "/commands/server/runtime.js", "/api/", "/config/", "/repository/"],
      })),
      { args: ["update", "--help"], blocked: ["/commands/review/", "/commands/update/updater.js", "semver", "read-cmd-shim"] },
      { args: ["task", "session", "read", "--help"], blocked: ["/commands/task/session/read.js", "/api/", "better-sqlite3"] },
      ...[[], ["--help"], ["recover", "--help"]].map(args => ({
        args: ["bot", ...args], blocked: ["/commands/bot/commands.js", "/commands/bot/recover.js", "/commands/worker/", "/commands/server/runtime.js", "/api/", "/config/", "better-sqlite3"],
      })),
      ...[[], ["--help"], ["bash"], ["zsh"], ["bash", "--help"], ["zsh", "--help"], ["setup", "--help"]].map((args) => ({
        args: ["completion", ...args], blocked: ["/commands/completion/setup.js", "/commands/review/", "/commands/update/", "better-sqlite3", "semver", "read-cmd-shim"],
      })),
      ...[[], ["--help"], ["install", "--help"]].map((args) => ({
        args: ["skill", ...args], blocked: ["@inquirer/", "which", "/commands/skill/agents.js", "/commands/skill/install.js", "/commands/skill/targets.js", "/commands/review/", "/config/", "/repository/", "/api/"],
      })),
      ...[[], ["--help"], ["run", "--help"], ["list", "--help"], ["add-repo", "--help"]].map((args) => ({
        args: ["review", ...args], blocked: [...reviewRuntime, "/commands/review/config.js", "/commands/review/repositories.js"],
      })),
    ];
    try {
      for (const { args, blocked } of cases) {
        const result = invoke(args, blocked);
        expect(result.error, args.join(" ")).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
      }
      await expect(readdir(home)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await cleanup(); }
  }, 30_000);
});
