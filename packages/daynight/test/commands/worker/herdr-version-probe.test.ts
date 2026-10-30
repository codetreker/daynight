import { describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { parseNativeAgentVersion, probeNativeAgentVersion } from "../../../src/commands/worker/herdr/version-probe.js";

describe("pure native agent version probes", () => {
  it.each([
    ["codex", "codex-cli 0.1.0\n", "0.1.0"],
    ["copilot", "GitHub Copilot CLI 1.0.83.\n", "1.0.83"],
    ["claude", "2.1.0 (Claude Code)\n", "2.1.0"],
  ] as const)("extracts %s versions without applying execution prerequisites", (agent, output, version) => {
    expect(parseNativeAgentVersion(agent, output)).toBe(version);
  });
  it("runs only --version in the supplied native environment and working directory", async () => {
    const op = createOperation(); const environment = { PATH: "/native", CODEX_HOME: "/native/codex" };
    const runCommand = vi.fn(async () => ({ stdout: "codex-cli 0.1.0\n", stderr: "" }));
    try {
      expect(await probeNativeAgentVersion({ agent: "codex", environment, cwd: "/work", runCommand }, op)).toBe("0.1.0");
      expect(runCommand).toHaveBeenCalledExactlyOnceWith({ file: "codex", args: ["--version"], environment, cwd: "/work" }, op);
    } finally { op.dispose(); }
  });
  it("rejects an unrecognized version without exposing output", () => {
    expect(() => parseNativeAgentVersion("codex", "secret credential")).toThrow("Cannot identify");
    try { parseNativeAgentVersion("codex", "secret credential"); } catch (error) { expect(String(error)).not.toContain("secret credential"); }
  });
});
