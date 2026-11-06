import { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperation, OperationError } from "../../../src/api/operation.js";
import { createAssistantHostCollector } from "../../../src/commands/worker/bots/host-capabilities.js";
import { HerdrCommandCleanupError, HerdrCommandError, runHerdrCommand } from "../../../src/commands/worker/herdr/command.js";
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
  it("probes the bundled Copilot version without forwarding to an automatic update", async () => {
    const commands: HerdrCommand[] = [];
    const { assistantHost } = await collect({ runCommand: async command => {
      commands.push(command);
      return output(command);
    } });
    expect(assistantHost.providers[2]!.available).toBe(true);
    expect(commands.filter(command => command.file === "copilot").map(command => command.args)).toEqual([
      ["--no-auto-update", "--version"],
      ["--headless", "--no-auto-update", "--help"],
    ]);
    expect(commands.find(command => command.file === "codex")!.args).toEqual(["--version"]);
    expect(commands.find(command => command.file === "claude")!.args).toEqual(["--version"]);
  });

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
      expect(assistantHost.providers.find(entry => entry.provider === agent)?.available).toBe(true);
      const ultra = await collect({ configuration: { ...configuration, agent, args: ["--effort", "ultra"] } });
      expect(ultra.assistantHost.providers.find(entry => entry.provider === agent)?.available).toBe(agent === "codex");
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

it("uses the current cloud native defaults on each observation without inheriting another provider's settings", async () => {
  let current = configuration;
  const collector = createAssistantHostCollector({ workingDirectory: root, configuration: () => current,
    environment: {}, resolveExecutable: provider => provider, runCommand: output });
  const operation = createOperation();
  try {
    expect((await collector.collect(operation)).assistantHost.defaultProvider).toBe("copilot");
    current = { agent: "codex", agentControlMode: "web", model: "new-model", args: [], recoveryLimit: 7 };
    const sample = (await collector.collect(operation)).assistantHost;
    expect(sample.defaultProvider).toBe("codex");
    expect(sample.providers).toEqual([
      { provider: "codex", available: true, reason: null, model: "new-model", args: [] },
      { provider: "claude", available: true, reason: null, model: null, args: [] },
      { provider: "copilot", available: true, reason: null, model: null, args: [] },
    ]);
  } finally { operation.dispose(); }
});


describe("assistant host cleanup recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  const timedOutProbe = async (terminationFailure = false) => {
    const child = new ChildProcess();
    if (terminationFailure) Object.defineProperty(child, "pid", { get: () => { throw new Error("Cannot terminate the owned process"); } });
    const operation = createOperation({ limits: { totalMs: 100, requestMs: 20 } });
    try {
      const result = runHerdrCommand({ file: "codex", args: ["--version"], environment: {} }, operation, () => child, { cleanupWithinDeadline: true }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(110);
      const failure = await result;
      expect(failure).toBeInstanceOf(HerdrCommandCleanupError);
      return { child, failure };
    } finally { operation.dispose(); }
  };
  const observe = async (collector: ReturnType<typeof createAssistantHostCollector>) => {
    const operation = createOperation();
    try { return await collector.collect(operation); } finally { operation.dispose(); }
  };
  const instance = (runCommand: NonNullable<Parameters<typeof createAssistantHostCollector>[0]["runCommand"]>) => createAssistantHostCollector({
    workingDirectory: root, configuration, environment: {}, resolveExecutable: provider => provider, runCommand,
  });

  it("reprobes version and help only after the original child closes, with a fresh observation time", async () => {
    const original = await timedOutProbe();
    const attempts: string[][] = [];
    const collector = instance(async command => {
      if (command.file === "codex") {
        attempts.push([...command.args]);
        if (attempts.length === 1) throw original.failure;
      }
      return output(command);
    });
    const first = await observe(collector);
    expect(first.assistantHost.providers[0]).toMatchObject({ available: false, reason: "unavailable" });
    const closeListeners = original.child.listenerCount("close");
    for (const elapsed of [1, 60_001, 120_001]) {
      await vi.advanceTimersByTimeAsync(elapsed);
      expect((await observe(collector)).assistantHost.providers[0]!.available).toBe(false);
    }
    original.child.emit("exit", 0, null);
    new ChildProcess().emit("close", 0, null);
    expect((await observe(collector)).assistantHost.providers[0]!.available).toBe(false);
    expect(attempts).toEqual([["--version"]]);
    expect(original.child.listenerCount("close")).toBe(closeListeners);
    original.child.emit("close", 0, null);
    const recovered = await observe(collector);
    expect(recovered.assistantHost.providers[0]).toMatchObject({ available: true, reason: null });
    expect(recovered.assistantHost.observedAt).not.toBe(first.assistantHost.observedAt);
    expect(recovered.issues).toEqual([]);
    expect(attempts).toEqual([["--version"], ["--version"], ["app-server", "--stdio", "--help"]]);
    expect(original.child.listenerCount("close")).toBe(0);
  });

  it("keeps different providers and successive cleanup failures bound to their own child", async () => {
    const codex = await timedOutProbe(); const claude = await timedOutProbe(); const nextCodex = await timedOutProbe();
    const attempts = { codex: 0, claude: 0 };
    const collector = instance(async command => {
      if (command.file === "codex" && ++attempts.codex <= 2) throw attempts.codex === 1 ? codex.failure : nextCodex.failure;
      if (command.file === "claude" && ++attempts.claude === 1) throw claude.failure;
      return output(command);
    });
    await observe(collector);
    codex.child.emit("close", 0, null);
    let sample = await observe(collector);
    expect(sample.assistantHost.providers.map(entry => entry.available)).toEqual([false, false, true]);
    expect(attempts).toEqual({ codex: 2, claude: 1 });
    codex.child.emit("close", 0, null);
    await observe(collector);
    expect(attempts).toEqual({ codex: 2, claude: 1 });
    claude.child.emit("close", 0, null);
    sample = await observe(collector);
    expect(sample.assistantHost.providers.map(entry => entry.available)).toEqual([false, true, true]);
    nextCodex.child.emit("close", 0, null);
    sample = await observe(collector);
    expect(sample.assistantHost.providers.every(entry => entry.available)).toBe(true);
    expect(attempts.codex).toBe(4);
  });

  it("retains a nested aggregate until every original cleanup has been confirmed", async () => {
    const first = await timedOutProbe(); const second = await timedOutProbe();
    const failure = new Error("Probe wrapper", { cause: new AggregateError([first.failure, new Error("Nested cleanup", { cause: second.failure })]) });
    let attempts = 0;
    const collector = instance(async command => {
      if (command.file === "codex" && ++attempts === 1) throw failure;
      return output(command);
    });
    await observe(collector);
    first.child.emit("close", 0, null);
    const blocked = await observe(collector);
    expect(blocked.issues.find(issue => issue.provider === "codex")?.error).toBe(failure);
    expect(attempts).toBe(1);
    second.child.emit("close", 0, null);
    expect((await observe(collector)).assistantHost.providers[0]!.available).toBe(true);
    expect(attempts).toBe(3);
  });

  it.each(["termination failure", "legacy cleanup"])("does not recover %s from a later close", async mode => {
    const original = await timedOutProbe(mode === "termination failure");
    const failure = mode === "legacy cleanup" ? new HerdrCommandCleanupError([new Error("No original confirmation handle")], undefined) : original.failure;
    let attempts = 0;
    const collector = instance(async command => {
      if (command.file === "codex") { attempts++; throw failure; }
      return output(command);
    });
    await observe(collector);
    original.child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(120_001);
    const blocked = await observe(collector);
    expect(blocked.assistantHost.providers[0]).toMatchObject({ available: false, reason: "unavailable" });
    expect(blocked.issues.find(issue => issue.provider === "codex")?.error).toBe(failure);
    expect(attempts).toBe(1);
  });

  it("reports the retry's actual failure and does not probe after parent cancellation", async () => {
    const original = await timedOutProbe();
    const currentFailure = new HerdrCommandError("Native executable failed", 2, null, "private diagnostic");
    let attempts = 0;
    const collector = instance(async command => {
      if (command.file === "codex") { attempts++; throw attempts === 1 ? original.failure : currentFailure; }
      return output(command);
    });
    await observe(collector);
    original.child.emit("close", 0, null);
    const retried = await observe(collector);
    expect(retried.assistantHost.providers[0]).toMatchObject({ available: false, reason: "command_failed" });
    expect(retried.issues.find(issue => issue.provider === "codex")?.error).toBe(currentFailure);
    const cancellation = new AbortController(); const operation = createOperation({ signal: cancellation.signal });
    cancellation.abort();
    try { await expect(collector.collect(operation)).rejects.toBe(operation.signal.reason); }
    finally { operation.dispose(); }
    expect(attempts).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
