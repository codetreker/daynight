import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOperation, OperationError } from "../../../src/api/operation.js";
import { createAssistantHostCollector } from "../../../src/commands/worker/bots/host-capabilities.js";
import { HerdrCommandCleanupError, HerdrCommandError } from "../../../src/commands/worker/herdr/command.js";
import type { HerdrCommand, HerdrCommandResult } from "../../../src/commands/worker/herdr/command.js";
import type { ExecutionConfiguration } from "../../../src/commands/worker/types.js";

let root: string;
beforeEach(async () => { const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp"); await mkdir(scratch, { recursive: true }); root = await mkdtemp(path.join(scratch, "host-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const configuration: ExecutionConfiguration = { agent: "copilot", agentControlMode: "herdr", model: "configured-model", args: ["--effort", "high"], recoveryLimit: 3 };
const output = async (command: HerdrCommand): Promise<HerdrCommandResult> => ({ stderr: "", stdout: command.args.includes("--version")
  ? command.file === "codex" ? "codex-cli 0.1.0" : command.file === "claude" ? "2.1.247 (Claude Code)" : "GitHub Copilot CLI 1.0.83"
  : command.file === "codex" ? "Usage: codex app-server --stdio" : command.file === "claude" ? "--input-format --output-format --permission-prompt-tool --include-partial-messages" : "--headless --no-auto-update" });
const collect = async (overrides: Partial<Parameters<typeof createAssistantHostCollector>[0]> = {}) => {
  const operation = createOperation();
  try { return await createAssistantHostCollector({ workingDirectory: root, configuration, environment: {}, resolveExecutable: provider => provider, runCommand: output, ...overrides }).collect(operation); }
  finally { operation.dispose(); }
};

describe("assistant host observations", () => {
  it("reports the global default independently of task mode and isolates other provider settings", async () => {
    const { assistantHost } = await collect();
    expect(assistantHost.defaultProvider).toBe("copilot");
    expect(assistantHost.defaultCwd).toBe(await realpath(root));
    expect(assistantHost.providers).toEqual([
      { provider: "codex", available: true, reason: null, model: null, args: [] },
      { provider: "claude", available: true, reason: null, model: null, args: [] },
      { provider: "copilot", available: true, reason: null, model: "configured-model", args: ["--effort", "high"] },
    ]);
  });

  it("rejects Herdr-only or secret arguments without including their text in the report", async () => {
    const { assistantHost } = await collect({ configuration: { ...configuration, args: ["--token", "private-token"] } });
    expect(assistantHost.providers[2]).toEqual({ provider: "copilot", available: false, reason: "unsupported_arguments", model: null, args: [] });
    expect(JSON.stringify(assistantHost)).not.toContain("private-token");
    expect(assistantHost.providers[0]!.available).toBe(true);
  });

  it("validates native Web argument rules for all three providers", async () => {
    for (const agent of ["codex", "claude", "copilot"] as const) {
      const { assistantHost } = await collect({ configuration: { ...configuration, agent, args: ["--effort", "max"] } });
      expect(assistantHost.providers.find(entry => entry.provider === agent)?.available).toBe(agent !== "copilot");
    }
  });

  it("rejects invalid configuration lengths before advertising or echoing them", async () => {
    for (const invalid of [{ model: "x".repeat(257) }, { args: ["--add-dir", "x".repeat(4097)] }, { args: Array(129).fill("x") }]) {
      const { assistantHost } = await collect({ configuration: { ...configuration, ...invalid } });
      expect(assistantHost.providers[2]).toEqual({ provider: "copilot", available: false, reason: "unsupported_arguments", model: null, args: [] });
    }
  });

  it("resolves a real ordinary directory without requiring a repository", async () => {
    const link = path.join(root, "alias"); const actual = path.join(root, "ordinary");
    await mkdir(actual); await symlink(actual, link, "dir");
    expect((await collect({ workingDirectory: link })).assistantHost.defaultCwd).toBe(await realpath(actual));
  });

  it("makes every provider unavailable for a missing directory or a regular file", async () => {
    const file = path.join(root, "file"); await writeFile(file, "fixture");
    for (const workingDirectory of [path.join(root, "absent"), file]) {
      const { assistantHost } = await collect({ workingDirectory });
      expect(assistantHost.providers.map(entry => [entry.available, entry.reason])).toEqual([[false, "invalid_cwd"], [false, "invalid_cwd"], [false, "invalid_cwd"]]);
    }
    expect(() => createAssistantHostCollector({ workingDirectory: "relative", configuration, environment: {} })).toThrow();
  });

  it("does not confuse a version with required Web transport support", async () => {
    const { assistantHost } = await collect({ runCommand: command => command.args.includes("--version") ? output(command) : Promise.resolve({ stdout: "Usage: native --help", stderr: "" }) });
    expect(assistantHost.providers.every(entry => !entry.available && entry.reason === "unavailable")).toBe(true);
  });

  it("keeps command output and causes private while exposing stable failure reasons", async () => {
    const failure = new HerdrCommandError("private-token", 1, null, "private-token");
    const { assistantHost, issues } = await collect({ runCommand: async () => { throw failure; } });
    expect(assistantHost.providers.every(entry => !entry.available && entry.reason === "command_failed")).toBe(true);
    expect(JSON.stringify(assistantHost)).not.toContain("private-token");
    expect(issues.every(issue => issue.error === failure)).toBe(true);
  });

  it("reports unavailable package resolution and malformed version output independently", async () => {
    const { assistantHost } = await collect({ resolveExecutable: provider => { if (provider === "claude") throw Object.assign(new Error("missing"), { code: "MODULE_NOT_FOUND" }); return provider; }, runCommand: command => command.file === "codex" ? Promise.resolve({ stdout: "private-token", stderr: "" }) : output(command) });
    expect(assistantHost.providers.map(entry => entry.reason)).toEqual(["invalid_output", "not_found", null]);
  });

  it("retains uncertain cleanup and never starts replacement probes", async () => {
    let attempts = 0;
    const failure = new HerdrCommandCleanupError([new Error("still-running")], undefined);
    const collector = createAssistantHostCollector({ workingDirectory: root, configuration, environment: {}, resolveExecutable: provider => provider, runCommand: async () => { attempts++; throw failure; } });
    const operation = createOperation();
    try {
      const first = await collector.collect(operation); const second = await collector.collect(operation);
      expect(attempts).toBe(3);
      expect(first.assistantHost.providers.every(entry => entry.reason === "unavailable")).toBe(true);
      expect(second.issues.every(issue => issue.error === failure)).toBe(true);
    } finally { operation.dispose(); }
  });

  it("propagates parent cancellation instead of returning a successful observation", async () => {
    const cancellation = new AbortController(); cancellation.abort();
    const operation = createOperation({ signal: cancellation.signal });
    try { await expect(createAssistantHostCollector({ workingDirectory: root, configuration, environment: {} }).collect(operation)).rejects.toBeInstanceOf(OperationError); }
    finally { operation.dispose(); }
  });
});
