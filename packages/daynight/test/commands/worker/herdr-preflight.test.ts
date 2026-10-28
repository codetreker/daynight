import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { createHerdrPreflight } from "../../../src/commands/worker/herdr/preflight.js";
import type { HerdrCommand } from "../../../src/commands/worker/herdr/command.js";

const roots: string[] = [];
const operations: Operation[] = [];
const id = "12345678-1234-4234-8234-123456789abc";
const operation = (limits: Parameters<typeof createOperation>[0] = {}) => {
  const op = createOperation(limits); operations.push(op); return op;
};
const quote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
const fixture = async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "hp-")); roots.push(root);
  const home = path.join(root, "user home"); const cwd = path.join(root, "worktree");
  const codex = path.join(home, ".codex"); const copilot = path.join(home, ".copilot");
  await Promise.all([mkdir(codex, { recursive: true }), mkdir(path.join(copilot, "hooks"), { recursive: true }), mkdir(cwd)]);
  const codexAsset = path.join(codex, "herdr-agent-state.sh"); const copilotAsset = path.join(copilot, "hooks", "herdr-agent-state.sh");
  await writeFile(codexAsset, "HERDR_INTEGRATION_VERSION=10\n"); await writeFile(copilotAsset, "HERDR_INTEGRATION_VERSION=4\n");
  const codexHooks = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: `bash ${quote(codexAsset)} session` }] }] } };
  await writeFile(path.join(codex, "hooks.json"), JSON.stringify(codexHooks));
  const hooks: Record<string, unknown> = { sessionStart: [{ type: "command", bash: `bash ${quote(copilotAsset)}` }] };
  const runCommand = vi.fn(async (command: HerdrCommand) => {
    if (command.file === "bash") return { stdout: "GNU bash, version 5.2.0\n", stderr: "" };
    if (command.file === "python3") return { stdout: "Python 3.12.3\n", stderr: "" };
    if (command.file === "powershell") return { stdout: "5.1.0\n", stderr: "" };
    if (command.args[0] === "--version") return { stdout: command.file === "codex" ? "codex-cli 0.164.0\n" : "GitHub Copilot CLI 1.0.103.\n", stderr: "" };
    if (command.args[0] === "--help") return { stdout: "--no-daemon   Run without the shared background server\n", stderr: "" };
    if (command.args.at(-2) === "features" && command.args.at(-1) === "list") return { stdout: "hooks\tstable\ttrue\n", stderr: "" };
    return { stdout: JSON.stringify(hooks), stderr: "" };
  });
  const integrations = [{ target: "codex", available: true, state: "current" }, { target: "copilot", available: true, state: "current" }];
  const rpc = { request: vi.fn(async () => ({ type: "integration_list", integrations })) };
  const environment: NodeJS.ProcessEnv = {};
  const preflight = createHerdrPreflight({ rpc, homeDirectory: home, environment, platform: "linux", runCommand });
  const input = (agent: "codex" | "copilot", resumeSessionId?: string) => ({ context: { cwd }, configuration: { agent, model: "frozen-model", args: [] as string[] }, ...(resumeSessionId === undefined ? {} : { resumeSessionId }) });
  const codexHistory = async (payload: Record<string, unknown> = { id, cwd }, suffix = ".jsonl") => {
    const directory = path.join(codex, "sessions", "2026", "10", "26"); await mkdir(directory, { recursive: true });
    const file = path.join(directory, `rollout-2026-10-26-${id}${suffix}`); await writeFile(file, `${JSON.stringify({ type: "session_meta", payload })}\n${"sensitive later turn".repeat(10)}\n`); return file;
  };
  const copilotHistory = async (session = id, historicalCwd = cwd) => {
    const directory = path.join(copilot, "session-state", id); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "workspace.yaml"), `id: ${session}\ncwd: ${JSON.stringify(historicalCwd)}\n`);
    const file = path.join(directory, "events.jsonl"); await writeFile(file, `${JSON.stringify({ type: "session.start", data: { sessionId: session, context: { cwd: historicalCwd } } })}\n`); return file;
  };
  return { root, home, cwd, codex, copilot, codexAsset, copilotAsset, codexHooks, hooks, integrations, environment, rpc, runCommand, preflight, input, codexHistory, copilotHistory };
};

afterEach(async () => {
  for (const op of operations.splice(0)) op.dispose();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Herdr native prerequisites", () => {
  it("checks actual Codex capability and hook configuration without requiring history for a new session", async () => {
    const f = await fixture();
    const result = await f.preflight.verifyStart(f.input("codex"), operation());
    expect(result).toEqual({ agent: "codex", version: "0.164.0", nativeHome: f.codex, sqliteHome: f.codex, integrationConfigured: true, history: null });
    expect(f.runCommand.mock.calls.map(([command]) => [command.file, command.args])).toEqual([["codex", ["--version"]], ["bash", ["--version"]], ["python3", ["--version"]], ["codex", ["--help"]], ["codex", ["features", "list"]]]);
    expect(JSON.parse(await readFile(path.join(f.codex, "hooks.json"), "utf8"))).toEqual(f.codexHooks);
    expect(f.rpc.request).toHaveBeenCalledWith("integration.list", {}, expect.anything());
    expect(f.runCommand.mock.calls.every(([command]) => command.cwd === f.cwd)).toBe(true);
  });

  it.each([undefined, id])("uses explicit frozen feature overrides for new and resumed starts (%s)", async (resume) => {
    const f = await fixture(); if (resume !== undefined) await f.codexHistory();
    const original = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementation(async (command) => command.args.at(-2) === "features" ? { stdout: `hooks stable ${command.args.includes("--enable=hooks")}\n`, stderr: "" } : original(command));
    const input = f.input("codex", resume);
    input.configuration.args = ["--config", "model_reasoning_effort=\"high\"", "--sandbox", "workspace-write", "--enable=hooks", "--dangerously-bypass-hook-trust"];
    expect((await f.preflight.verifyStart(input, operation())).integrationConfigured).toBe(true);
    expect(f.runCommand.mock.calls.find(([command]) => command.args.at(-2) === "features")?.[0]).toMatchObject({ cwd: f.cwd, args: ["--config", "model_reasoning_effort=\"high\"", "--enable=hooks", "features", "list"] });
  });

  it("retains configuration and feature override order while excluding runtime modes", async () => {
    const f = await fixture(); const input = f.input("codex");
    input.configuration.args = ["--disable", "search", "-c", "features.hooks=false", "--enable", "hooks", "--config=features.other=true", "--no-alt-screen"];
    await f.preflight.verifyStart(input, operation());
    expect(f.runCommand.mock.calls.find(([command]) => command.args.at(-2) === "features")?.[0].args).toEqual(["--disable", "search", "-c", "features.hooks=false", "--enable", "hooks", "--config=features.other=true", "features", "list"]);
  });

  it("checks an explicit config override against the effective native feature result", async () => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!; const input = f.input("codex"); input.configuration.args = ["--config=features.hooks=true"];
    f.runCommand.mockImplementation(async (command) => command.args.at(-2) === "features" ? { stdout: `hooks stable ${command.args.includes("--config=features.hooks=true")}\n`, stderr: "" } : original(command));
    await expect(f.preflight.verifyStart(input, operation())).resolves.toMatchObject({ integrationConfigured: true });
    expect(f.runCommand.mock.calls.find(([command]) => command.args.at(-2) === "features")?.[0].args).toEqual(["--config=features.hooks=true", "features", "list"]);
  });

  it("rejects an explicitly disabled effective hook feature", async () => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!; const input = f.input("codex"); input.configuration.args = ["--disable", "hooks"];
    f.runCommand.mockImplementation(async (command) => command.args.at(-2) === "features" ? { stdout: "hooks stable false\n", stderr: "" } : original(command));
    await expect(f.preflight.verifyStart(input, operation())).rejects.toThrow("hooks are disabled");
    expect(f.runCommand.mock.calls.find(([command]) => command.args.at(-2) === "features")?.[0].args).toEqual(["--disable", "hooks", "features", "list"]);
  });

  it("uses the task cwd for effective task-local configuration checks", async () => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementation(async (command) => command.args.at(-2) === "features" ? { stdout: `hooks stable ${command.cwd === f.cwd}\n`, stderr: "" } : original(command));
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).resolves.toMatchObject({ integrationConfigured: true });
    await f.preflight.verifyStart(f.input("copilot"), operation());
    expect(f.runCommand.mock.calls.every(([command]) => command.cwd === f.cwd)).toBe(true);
  });

  it.each([undefined, id])("reports unsupported read-only profile inspection for new and resumed starts (%s)", async (resume) => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!; const failure = new Error("selected profile rejected by native features list");
    f.runCommand.mockImplementation(async (command) => { if (command.args.at(-2) === "features") throw failure; return original(command); });
    const input = f.input("codex", resume); input.configuration.args = ["--config", "features.other=true", "--profile=work", "--enable", "hooks", "--sandbox", "workspace-write"];
    await expect(f.preflight.verifyStart(input, operation())).rejects.toMatchObject({ message: expect.stringContaining("selected profile"), cause: failure });
    const checks = f.runCommand.mock.calls.filter(([command]) => command.args.at(-2) === "features");
    expect(checks).toHaveLength(1); expect(checks[0]![0]).toMatchObject({ cwd: f.cwd, args: ["--config", "features.other=true", "--profile=work", "--enable", "hooks", "features", "list"] });
    expect(f.runCommand.mock.calls.some(([command]) => command.args.includes("mcp"))).toBe(false);
  });

  it("accepts native profile inspection when the CLI genuinely supports the same query", async () => {
    const f = await fixture(); const input = f.input("codex"); input.configuration.args = ["-p", "work", "--enable", "hooks"];
    expect((await f.preflight.verifyStart(input, operation())).integrationConfigured).toBe(true);
    expect(f.runCommand.mock.calls.find(([command]) => command.args.at(-2) === "features")?.[0].args).toEqual(["-p", "work", "--enable", "hooks", "features", "list"]);
  });

  it("checks Copilot's effective normalized hooks rather than treating asset installation as sufficient", async () => {
    const f = await fixture(); const result = await f.preflight.verifyStart(f.input("copilot"), operation());
    expect(result.agent).toBe("copilot"); expect(result.sqliteHome).toBeNull();
    expect(f.runCommand.mock.calls.map(([command]) => [command.file, command.args])).toEqual([["copilot", ["--version"]], ["bash", ["--version"]], ["python3", ["--version"]], ["copilot", ["config", "hooks"]]]);
    f.hooks.sessionStart = [{ type: "command", bash: `echo ${quote(f.copilotAsset)}` }];
    await expect(f.preflight.verifyStart(f.input("copilot"), operation())).rejects.toThrow("does not invoke");
  });

  it("validates the official PowerShell hook registration on Windows", async () => {
    const f = await fixture();
    const codexAsset = path.join(f.codex, "herdr-agent-state.ps1"); const copilotAsset = path.join(f.copilot, "hooks", "herdr-agent-state.ps1");
    await writeFile(codexAsset, "# HERDR_INTEGRATION_VERSION=10\n"); await writeFile(copilotAsset, "# HERDR_INTEGRATION_VERSION=4\n");
    const command = (asset: string) => `powershell -NoProfile -ExecutionPolicy Bypass -File "${asset}"`;
    await writeFile(path.join(f.codex, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${command(codexAsset)} session` }] }] } }));
    f.hooks.sessionStart = [{ type: "command", powershell: command(copilotAsset) }];
    const preflight = createHerdrPreflight({ rpc: f.rpc, environment: {}, homeDirectory: f.home, platform: "win32", runCommand: f.runCommand });
    expect((await preflight.verifyStart(f.input("codex"), operation())).integrationConfigured).toBe(true);
    expect((await preflight.verifyStart(f.input("copilot"), operation())).integrationConfigured).toBe(true);
    f.hooks.sessionStart = [{ type: "command", bash: command(copilotAsset) }];
    await expect(preflight.verifyStart(f.input("copilot"), operation())).rejects.toThrow("does not invoke");
  });

  it("requires an actual executable version even when installed integration metadata claims availability", async () => {
    const f = await fixture(); const failure = new Error("native executable unavailable"); f.runCommand.mockRejectedValueOnce(failure);
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toBe(failure); expect(f.rpc.request).not.toHaveBeenCalled();
  });

  it.each(["not_installed", "outdated"])("refuses integration state %s without installation or rewrite", async (state) => {
    const f = await fixture(); f.integrations[0]!.state = state;
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("missing or outdated");
    expect(f.rpc.request.mock.calls).toHaveLength(1); expect(f.runCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicated or malformed integration inventory", async () => {
    const f = await fixture(); f.integrations.push(f.integrations[0]!);
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("missing or outdated");
    f.rpc.request.mockResolvedValueOnce({ type: "wrong", integrations: [] });
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("invalid integration");
  });

  it("refuses Codex without isolated execution or enabled hooks", async () => {
    const f = await fixture();
    const original = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementation(async (command) => command.args[0] === "--help" ? { stdout: "no relevant capability", stderr: "" } : original(command));
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("lacks --no-daemon");
    f.runCommand.mockImplementation(async (command) => command.args[0] === "features" ? { stdout: "hooks stable false", stderr: "" } : original(command));
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("hooks are disabled");
  });

  it("reports the missing official hook runtime without starting a native session", async () => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementation(async (command) => { if (command.file === "python3") throw new Error("runtime absent"); return original(command); });
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("requires the python3 runtime");
    expect(f.runCommand.mock.calls.some(([command]) => command.args.includes("features"))).toBe(false);
  });

  it("rejects hook commands that cannot run the official SessionStart reporter", async () => {
    const f = await fixture(); f.codexHooks.hooks.SessionStart[0]!.hooks[0]!.command += " && echo changed";
    await writeFile(path.join(f.codex, "hooks.json"), JSON.stringify(f.codexHooks));
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("configure and trust");
  });

  it("resolves explicit independent native and SQLite homes without changing the supplied environment", async () => {
    const f = await fixture(); const environment = { CODEX_HOME: f.codex, CODEX_SQLITE_HOME: path.join(f.root, "separate database"), COPILOT_HOME: f.copilot, XDG_CONFIG_HOME: "ignored-by-native-roots" };
    const before = { ...environment }; const preflight = createHerdrPreflight({ rpc: f.rpc, environment, homeDirectory: f.home, platform: "linux", runCommand: f.runCommand });
    const result = await preflight.verifyStart(f.input("codex"), operation()); expect(result.sqliteHome).toBe(environment.CODEX_SQLITE_HOME); expect(environment).toEqual(before);
  });

  it.each(["", "relative", "~/.codex"])("rejects ambiguous native home override %s", async (CODEX_HOME) => {
    const f = await fixture(); const preflight = createHerdrPreflight({ rpc: f.rpc, environment: { CODEX_HOME }, homeDirectory: f.home, runCommand: f.runCommand });
    await expect(preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("absolute path"); expect(f.runCommand).not.toHaveBeenCalled();
  });

  it("validates an exact Codex rollout manifest and original working directory", async () => {
    const f = await fixture(); const file = await f.codexHistory();
    const result = await f.preflight.verifyStart(f.input("codex", id), operation()); expect(result.history).toEqual({ path: file, sessionId: id, cwd: f.cwd });
    await f.codexHistory({ id: "different", cwd: f.cwd });
    await expect(f.preflight.verifyStart(f.input("codex", id), operation())).rejects.toThrow("does not identify");
  });

  it("refuses missing, ambiguous and compressed Codex history instead of manufacturing a new session", async () => {
    const f = await fixture(); await mkdir(path.join(f.codex, "sessions"));
    await expect(f.preflight.verifyStart(f.input("codex", id), operation())).rejects.toThrow("found 0");
    const file = await f.codexHistory(); await f.codexHistory({ id, cwd: f.cwd }, ".jsonl.gz");
    await expect(f.preflight.verifyStart(f.input("codex", id), operation())).rejects.toThrow("found 2");
    await rm(file); await expect(f.preflight.verifyStart(f.input("codex", id), operation())).rejects.toThrow("Compressed Codex");
  });

  it("rejects native history from another existing checkout", async () => {
    const f = await fixture(); const elsewhere = path.join(f.root, "another checkout"); await mkdir(elsewhere); await f.codexHistory({ id, cwd: elsewhere });
    await expect(f.preflight.verifyStart(f.input("codex", id), operation())).rejects.toThrow("different working directory");
  });

  it("checks both Copilot workspace metadata and its original session.start event", async () => {
    const f = await fixture(); const file = await f.copilotHistory();
    expect((await f.preflight.verifyStart(f.input("copilot", id), operation())).history).toEqual({ path: file, sessionId: id, cwd: f.cwd });
    await writeFile(file, JSON.stringify({ type: "session.start", data: { sessionId: "wrong", context: { cwd: f.cwd } } }));
    await expect(f.preflight.verifyStart(f.input("copilot", id), operation())).rejects.toThrow("does not identify");
  });

  it("rejects corrupt Copilot metadata without including file content in the error", async () => {
    const f = await fixture(); await f.copilotHistory(); const secret = "private-marker-not-for-errors";
    await writeFile(path.join(f.copilot, "session-state", id, "workspace.yaml"), `invalid: [${secret}`);
    const failure = await f.preflight.verifyStart(f.input("copilot", id), operation()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).not.toContain(secret); expect((failure as Error).cause).toBeUndefined();
  });

  it("rejects unsafe session identities before traversing native history", async () => {
    const f = await fixture(); await expect(f.preflight.verifyStart(f.input("codex", "../../foreign"), operation())).rejects.toThrow("exact UUID");
  });

  it("honors cancellation before commands and retains the original cancellation error", async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort(new Error("stop prerequisite checking")); const op = operation({ signal: controller.signal });
    await expect(f.preflight.verifyStart(f.input("codex"), op)).rejects.toBe(op.signal.reason); expect(f.runCommand).not.toHaveBeenCalled();
  });

  it("bounds metadata bytes and reports invalid JSON without echoing sensitive source", async () => {
    const f = await fixture(); await writeFile(path.join(f.codex, "hooks.json"), "x".repeat(1_048_577));
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("one MiB");
    await writeFile(path.join(f.codex, "hooks.json"), "secret-invalid-json");
    const failure = await f.preflight.verifyStart(f.input("codex"), operation()).catch((error: unknown) => error);
    expect((failure as Error).message).toContain("not valid JSON"); expect((failure as Error).message).not.toContain("secret-invalid-json");
  });
});
it("checks Claude root hooks and rejects local hook disabling before starting native execution", async () => {
  const f = await fixture(); const root = path.join(f.home, ".claude"); await mkdir(path.join(root, "hooks"), { recursive: true });
  const hook = path.join(root, "hooks", "herdr-agent-state.sh"); await writeFile(hook, "# official fixture\n");
  await writeFile(path.join(root, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ matcher: "^(startup|resume|clear|compact|fork)$", hooks: [{ type: "command", command: `bash ${quote(hook)} session` }] }] } }));
  f.integrations.push({ target: "claude", available: true, state: "current" });
  const original = f.runCommand.getMockImplementation()!; f.runCommand.mockImplementation(async command => command.file === "claude" ? { stdout: "2.1.247 (Claude Code)\n", stderr: "" } : original(command));
  const input = { context: { cwd: f.cwd }, configuration: { agent: "claude" as const, model: null, args: [] } };
  expect(await f.preflight.verifyStart(input, operation())).toMatchObject({ agent: "claude", version: "2.1.247", nativeHome: root });
  await mkdir(path.join(f.cwd, ".claude")); await writeFile(path.join(f.cwd, ".claude", "settings.local.json"), JSON.stringify({ disableAllHooks: true }));
  await expect(f.preflight.verifyStart(input, operation())).rejects.toThrow(/disabled/);
});
