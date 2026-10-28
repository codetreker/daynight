import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { createHerdrPreflight } from "../../../src/commands/worker/herdr/preflight.js";
import { codexProjectTrustArguments } from "../../../src/commands/worker/herdr/arguments.js";
import type { HerdrCommand } from "../../../src/commands/worker/herdr/command.js";
import { HerdrRpcError } from "../../../src/commands/worker/herdr/rpc.js";
import type { HerdrRpcClient, HerdrRpcResult } from "../../../src/commands/worker/herdr/rpc.js";

const roots: string[] = [];
const operations: Operation[] = [];
const pong = { type: "pong", version: "0.9.5", protocol: 22, capabilities: {} };
const id = "12345678-1234-4234-8234-123456789abc";
const codexPermissionFlags = ["--no-daemon", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"];
const copilotPermissionFlags = ["--allow-all", "--no-ask-user", "--no-sandbox"];
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
    if (command.args.includes("--help")) return { stdout: [...codexPermissionFlags, ...copilotPermissionFlags].join("\n"), stderr: "" };
    if (command.args.at(-2) === "features" && command.args.at(-1) === "list") return { stdout: "hooks\tstable\ttrue\n", stderr: "" };
    return { stdout: JSON.stringify(hooks), stderr: "" };
  });
  const integrations = [{ target: "codex", label: "Codex", command: "codex", available: true, state: "current" }, { target: "copilot", label: "Copilot", command: "copilot", available: true, state: "current" }];
  const rpc = { request: vi.fn<HerdrRpcClient["request"]>(async (method) => method === "ping" ? pong : ({ type: "integration_list", integrations })) };
  const environment: NodeJS.ProcessEnv = {};
  const assertIntegrationEnvironment = vi.fn<(root: string) => void>();
  const preflight = createHerdrPreflight({ assertIntegrationEnvironment, rpc, homeDirectory: home, environment, platform: "linux", runCommand });
  const input = (agent: "codex" | "copilot", resumeSessionId?: string) => ({ context: { cwd }, configuration: { agent, model: "current-model", args: [] as string[] }, ...(resumeSessionId === undefined ? {} : { resumeSessionId }) });
  return { root, home, cwd, codex, copilot, codexAsset, copilotAsset, codexHooks, hooks, integrations, environment, rpc, runCommand, preflight, input, assertIntegrationEnvironment };
};

afterEach(async () => {
  for (const op of operations.splice(0)) op.dispose();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Herdr native prerequisites", () => {
  it("checks actual Codex capability and hook configuration without requiring history for a new session", async () => {
    const f = await fixture();
    const result = await f.preflight.verifyStart(f.input("codex"), operation());
    expect(result).toEqual({ agent: "codex", version: "0.164.0", nativeHome: f.codex, integrationConfigured: true });
    expect(f.runCommand.mock.calls.map(([command]) => [command.file, command.args])).toEqual([["codex", ["--version"]], ["bash", ["--version"]], ["python3", ["--version"]], ["codex", [...codexPermissionFlags, "--help"]], ["codex", [...codexProjectTrustArguments(f.cwd), "features", "list"]]]);
    expect(JSON.parse(await readFile(path.join(f.codex, "hooks.json"), "utf8"))).toEqual(f.codexHooks);
    expect(f.rpc.request).toHaveBeenCalledWith("integration.list", {}, expect.anything());
    expect(f.rpc.request).toHaveBeenCalledTimes(1);
    expect(f.runCommand.mock.calls.every(([command]) => command.cwd === f.cwd)).toBe(true);
  });

  it.each([undefined, id])("uses explicit feature overrides for new and resumed starts (%s)", async (resume) => {
    const f = await fixture();
    const original = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementation(async (command) => command.args.at(-2) === "features" ? { stdout: `hooks stable ${command.args.includes("--enable=hooks")}\n`, stderr: "" } : original(command));
    const input = f.input("codex", resume);
    input.configuration.args = ["--config", "model_reasoning_effort=\"high\"", "--no-alt-screen", "--enable=hooks"];
    expect((await f.preflight.verifyStart(input, operation())).integrationConfigured).toBe(true);
    expect(f.runCommand.mock.calls.find(([command]) => command.args.at(-2) === "features")?.[0]).toMatchObject({ cwd: f.cwd, args: ["--config", "model_reasoning_effort=\"high\"", "--enable=hooks", ...codexProjectTrustArguments(f.cwd), "features", "list"] });
  });

  it("retains configuration and feature override order while excluding runtime modes", async () => {
    const f = await fixture(); const input = f.input("codex");
    input.configuration.args = ["--disable", "search", "-c", "features.hooks=false", "--enable", "hooks", "--config=features.other=true", "--no-alt-screen"];
    await f.preflight.verifyStart(input, operation());
    expect(f.runCommand.mock.calls.find(([command]) => command.args.at(-2) === "features")?.[0].args).toEqual(["--disable", "search", "-c", "features.hooks=false", "--enable", "hooks", "--config=features.other=true", ...codexProjectTrustArguments(f.cwd), "features", "list"]);
  });

  it("checks an explicit config override against the effective native feature result", async () => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!; const input = f.input("codex"); input.configuration.args = ["--config=features.hooks=true"];
    f.runCommand.mockImplementation(async (command) => command.args.at(-2) === "features" ? { stdout: `hooks stable ${command.args.includes("--config=features.hooks=true")}\n`, stderr: "" } : original(command));
    await expect(f.preflight.verifyStart(input, operation())).resolves.toMatchObject({ integrationConfigured: true });
    expect(f.runCommand.mock.calls.find(([command]) => command.args.at(-2) === "features")?.[0].args).toEqual(["--config=features.hooks=true", ...codexProjectTrustArguments(f.cwd), "features", "list"]);
  });

  it("rejects an explicitly disabled effective hook feature", async () => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!; const input = f.input("codex"); input.configuration.args = ["--disable", "hooks"];
    f.runCommand.mockImplementation(async (command) => command.args.at(-2) === "features" ? { stdout: "hooks stable false\n", stderr: "" } : original(command));
    await expect(f.preflight.verifyStart(input, operation())).rejects.toThrow("hooks are disabled");
    expect(f.runCommand.mock.calls.find(([command]) => command.args.at(-2) === "features")?.[0].args).toEqual(["--disable", "hooks", ...codexProjectTrustArguments(f.cwd), "features", "list"]);
  });

  it("uses the task cwd for effective task-local configuration checks", async () => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementation(async (command) => command.args.at(-2) === "features" ? { stdout: `hooks stable ${command.cwd === f.cwd}\n`, stderr: "" } : original(command));
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).resolves.toMatchObject({ integrationConfigured: true });
    await f.preflight.verifyStart(f.input("copilot"), operation());
    expect(f.runCommand.mock.calls.every(([command]) => command.cwd === f.cwd)).toBe(true);
  });

  it("inspects Codex features with the same final canonical folder trust as a native launch", async () => {
    const f = await fixture(); const input = f.input("codex");
    const canonicalCwd = await realpath(f.cwd); const alias = path.join(f.root, "worktree.alias"); await symlink(canonicalCwd, alias, "junction"); input.context.cwd = alias;
    input.configuration.args = ["-c", 'projects={"other"={trust_level="untrusted"}}', "--enable", "hooks"];
    await f.preflight.verifyStart(input, operation());
    expect(f.runCommand.mock.calls.find(([command]) => command.args.at(-2) === "features")?.[0]).toMatchObject({ cwd: canonicalCwd, args: [...input.configuration.args, ...codexProjectTrustArguments(canonicalCwd), "features", "list"] });
  });

  it("overrides hostile Copilot permission environment consistently for native inspection", async () => {
    const f = await fixture(); const environment = { COPILOT_ALLOW_ALL: "false", COPILOT_ASSISTED_APPROVAL: "true", COPILOT_HOME: f.copilot, OTHER: "preserved" };
    const preflight = createHerdrPreflight({ assertIntegrationEnvironment: f.assertIntegrationEnvironment, rpc: f.rpc, environment, homeDirectory: f.home, platform: "linux", runCommand: f.runCommand });
    await preflight.verifyStart(f.input("copilot", id), operation());
    expect(f.runCommand.mock.calls.every(([command]) => command.environment.COPILOT_ALLOW_ALL === "true" && command.environment.COPILOT_ASSISTED_APPROVAL === "false" && command.environment.OTHER === "preserved")).toBe(true);
    expect(environment.COPILOT_ALLOW_ALL).toBe("false"); expect(environment.COPILOT_ASSISTED_APPROVAL).toBe("true");
  });

  it.each(["codex", "copilot"] as const)("rejects conflicting %s arguments before preflight commands or RPC", async (agent) => {
    const f = await fixture(); const input = f.input(agent); input.configuration.args = agent === "codex" ? ["--ask-for-approval=on-request"] : ["--assisted-approval"];
    await expect(f.preflight.verifyStart(input, operation())).rejects.toThrow("owned by the worker");
    expect(f.runCommand).not.toHaveBeenCalled(); expect(f.rpc.request).not.toHaveBeenCalled();
  });

  it.each([undefined, id])("reports unsupported read-only profile inspection for new and resumed starts (%s)", async (resume) => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!; const failure = new Error("selected profile rejected by native features list");
    f.runCommand.mockImplementation(async (command) => { if (command.args.at(-2) === "features") throw failure; return original(command); });
    const input = f.input("codex", resume); input.configuration.args = ["--config", "features.other=true", "--profile=work", "--enable", "hooks", "--no-alt-screen"];
    await expect(f.preflight.verifyStart(input, operation())).rejects.toMatchObject({ message: expect.stringContaining("selected profile"), cause: failure });
    const checks = f.runCommand.mock.calls.filter(([command]) => command.args.at(-2) === "features");
    expect(checks).toHaveLength(1); expect(checks[0]![0]).toMatchObject({ cwd: f.cwd, args: ["--config", "features.other=true", "--profile=work", "--enable", "hooks", ...codexProjectTrustArguments(f.cwd), "features", "list"] });
    expect(f.runCommand.mock.calls.some(([command]) => command.args.includes("mcp"))).toBe(false);
  });

  it("accepts native profile inspection when the CLI genuinely supports the same query", async () => {
    const f = await fixture(); const input = f.input("codex"); input.configuration.args = ["-p", "work", "--enable", "hooks"];
    expect((await f.preflight.verifyStart(input, operation())).integrationConfigured).toBe(true);
    expect(f.runCommand.mock.calls.find(([command]) => command.args.at(-2) === "features")?.[0].args).toEqual(["-p", "work", "--enable", "hooks", ...codexProjectTrustArguments(f.cwd), "features", "list"]);
  });

  it("checks Copilot's effective normalized hooks rather than treating asset installation as sufficient", async () => {
    const f = await fixture(); const result = await f.preflight.verifyStart(f.input("copilot"), operation());
    expect(result.agent).toBe("copilot");
    expect(f.runCommand.mock.calls.map(([command]) => [command.file, command.args])).toEqual([["copilot", ["--version"]], ["bash", ["--version"]], ["python3", ["--version"]], ["copilot", [...copilotPermissionFlags, "--help"]], ["copilot", ["config", "hooks"]]]);
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
    const preflight = createHerdrPreflight({ assertIntegrationEnvironment: f.assertIntegrationEnvironment, rpc: f.rpc, environment: {}, homeDirectory: f.home, platform: "win32", runCommand: f.runCommand });
    expect((await preflight.verifyStart(f.input("codex"), operation())).integrationConfigured).toBe(true);
    expect((await preflight.verifyStart(f.input("copilot"), operation())).integrationConfigured).toBe(true);
    f.hooks.sessionStart = [{ type: "command", bash: command(copilotAsset) }];
    await expect(preflight.verifyStart(f.input("copilot"), operation())).rejects.toThrow("does not invoke");
  });

  it("requires an actual executable version even when installed integration metadata claims availability", async () => {
    const f = await fixture(); const failure = new Error("native executable unavailable"); f.runCommand.mockRejectedValueOnce(failure);
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toBe(failure); expect(f.rpc.request).not.toHaveBeenCalled();
  });

  it("refuses Codex releases that expose hook bypass but still prompt during TUI startup", async () => {
    const f = await fixture(); f.runCommand.mockResolvedValueOnce({ stdout: "codex-cli 0.134.0\n", stderr: "" });
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("Codex 0.135.0 or newer");
    expect(f.rpc.request).not.toHaveBeenCalled(); expect(f.runCommand).toHaveBeenCalledTimes(1);
  });

  it.each(["--no-daemon", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"])("requires Codex capability %s in addition to its version", async (missing) => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementation(async (command) => command.args.includes("--help") ? { stdout: codexPermissionFlags.filter((flag) => flag !== missing).join("\n"), stderr: "" } : original(command));
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow(`lacks ${missing}`);
    expect(f.runCommand.mock.calls.some(([command]) => command.args.includes("features"))).toBe(false);
  });

  it("surfaces Copilot's rejection of the combined permission flags before launch", async () => {
    const f = await fixture(); const original = f.runCommand.getMockImplementation()!; const failure = new Error("unsupported --no-sandbox");
    f.runCommand.mockImplementation(async (command) => { if (command.args.includes("--help")) throw failure; return original(command); });
    await expect(f.preflight.verifyStart(f.input("copilot"), operation())).rejects.toBe(failure);
    expect(f.runCommand.mock.calls.find(([command]) => command.args.includes("--help"))?.[0].args).toEqual([...copilotPermissionFlags, "--help"]);
    expect(f.runCommand.mock.calls.some(([command]) => command.args[0] === "config")).toBe(false);
  });

  it.each(["codex", "copilot"] as const)("keeps current %s integration read-only", async (agent) => {
    const f = await fixture(); const op = operation();
    await f.preflight.verifyStart(f.input(agent), op);
    expect(f.rpc.request.mock.calls).toEqual([["integration.list", {}, op]]);
  });

  it.each([
    ["codex", "not_installed"], ["codex", "outdated"],
    ["copilot", "not_installed"], ["copilot", "outdated"],
  ] as const)("repairs %s integration state %s before inspecting installed assets and effective hooks", async (agent, state) => {
    const f = await fixture(); const info = f.integrations.find((item) => item.target === agent)!; info.state = state;
    const asset = agent === "codex" ? f.codexAsset : f.copilotAsset;
    await rm(asset);
    if (agent === "codex") await rm(path.join(f.codex, "hooks.json"));
    else f.hooks.sessionStart = [];
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === "integration.list") return { type: "integration_list", integrations: f.integrations };
      if (method === "ping") return pong;
      expect(method).toBe("integration.install"); expect(params).toEqual({ target: agent });
      expect(f.runCommand).toHaveBeenCalledTimes(1);
      await writeFile(asset, "officially installed hook\n");
      if (agent === "codex") await writeFile(path.join(f.codex, "hooks.json"), JSON.stringify(f.codexHooks));
      else f.hooks.sessionStart = [{ type: "command", bash: `bash ${quote(asset)}` }];
      info.state = "current";
      return { type: "integration_install", target: agent, details: { messages: ["Installed"] } };
    });
    const op = operation();
    await expect(f.preflight.verifyStart(f.input(agent), op)).resolves.toMatchObject({ agent, integrationConfigured: true });
    expect(f.rpc.request.mock.calls).toEqual([["integration.list", {}, op], ...(agent === "codex" ? [["ping", {}, op]] : []), ["integration.install", { target: agent }, op], ["integration.list", {}, op]]);
    expect(f.runCommand.mock.calls.some(([command]) => command.args.at(-2) === (agent === "codex" ? "features" : "config"))).toBe(true);
  });

  const unsafeConfigurations = [
    ["inline features", 'features = { hooks = false, shell_tool = true }\n'],
    ["dotted features", 'features.hooks = true\n'],
    ["dotted sibling", 'features.shell_tool = true\n'],
    ["quoted dotted features", '"features"."hooks" = false\n'],
    ["quoted table", '["features"]\nhooks = false\n'],
    ["literal table", "['features']\nhooks = false\n"],
    ["spaced table", '[ features ]\nhooks = false\n'],
    ["quoted hooks", '[features]\n"hooks" = false\n'],
    ["literal hooks", "[features]\n'hooks' = true\n"],
    ["multiline fake header", 'developer_instructions = """\n[features]\nhooks = false\n"""\n'],
    ["multiline deletion", 'developer_instructions = """\n[features]\ncodex_hooks = Keep this private instruction.\n"""\n[features]\nhooks = false\n'],
    ["literal multiline deletion", "developer_instructions = '''\n[features]\ncodex_hooks = Keep this private instruction.\n'''\n[features]\nhooks = false\n"],
    ["BOM before header", '\ufeff[features]\nhooks = false\n'],
    ["invalid TOML", 'private-token = "never-echo-this-token\n'],
    ["date precision", 'created = 1979-05-27T07:32:00.123456789Z\n'],
    ["unsafe key", 'constructor = "private"\n'],
  ] as const;

  it.each(unsafeConfigurations.flatMap(([label, source]) => ["not_installed", "outdated"].map((state) => ({ label, source, state }))))("refuses unsafe $label before $state installation without changing native files", async ({ source, state }) => {
    const f = await fixture(); f.integrations[0]!.state = state;
    const config = path.join(f.codex, "config.toml");
    await writeFile(config, source);
    const files = [config, path.join(f.codex, "hooks.json"), f.codexAsset];
    const before = await Promise.all(files.map((file) => readFile(file)));
    const failure = await f.preflight.verifyStart(f.input("codex"), operation()).catch((cause: unknown) => cause) as Error;
    expect(failure.message).toContain("Cannot safely install");
    expect(failure.cause).toBeUndefined();
    expect(failure.message).not.toContain(source);
    expect(failure.message).not.toContain("never-echo-this-token");
    expect(f.rpc.request.mock.calls.map(([method]) => method)).toEqual(["integration.list", "ping"]);
    expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(before);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["canonical missing key", "[features]\nshell_tool = true\n"],
    ["canonical false", "[features]\nhooks = false\n"],
    ["CRLF", "[features] # native\r\nhooks = false # comment\r\n"],
    ["deprecated root key", "[profiles.work.features]\ncodex_hooks = true\nhooks = false\n[features]\ncodex_hooks = true\nhooks = false\n"],
    ["unrelated multiline", 'developer_instructions = """\nKeep this text.\n"""\n[features]\nhooks = false\n'],
    ["large integers and floats", "large = 9223372036854775807\nsmall = 1\nfloat = 1.0\nnan = nan\npositive = inf\nnegative = -inf\nzero = -0.0\n"],
    ["BOM before model", '\ufeffmodel = "native"\n'],
  ] as const)("allows the official installer for safe %s configuration without writing it locally", async (_label, source) => {
    const f = await fixture(); f.integrations[0]!.state = "outdated";
    const file = path.join(f.codex, "config.toml");
    if (source !== undefined) await writeFile(file, source);
    f.rpc.request.mockImplementation(async (method) => {
      if (method === "integration.list") return { type: "integration_list", integrations: f.integrations };
      if (method === "ping") return pong;
      expect(method).toBe("integration.install");
      if (source === undefined) await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(file, "utf8")).toBe(source);
      f.integrations[0]!.state = "current";
      return { type: "integration_install", target: "codex", details: { messages: [] } };
    });
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).resolves.toMatchObject({ integrationConfigured: true });
    expect(f.rpc.request.mock.calls.map(([method]) => method)).toEqual(["integration.list", "ping", "integration.install", "integration.list"]);
    if (source !== undefined) expect(await readFile(file, "utf8")).toBe(source);
  });

  it.each([
    { ...pong, version: "0.9.6" }, { ...pong, version: "0.9.5+custom" },
    { ...pong, version: "0.9.4" }, { ...pong, version: undefined },
    { ...pong, type: "wrong" }, { ...pong, protocol: 23 },
    { ...pong, capabilities: undefined }, { ...pong, capabilities: [] }, { ...pong, capabilities: null },
  ])("rejects unaudited Codex installer metadata (%j)", async (result) => {
    const f = await fixture(); f.integrations[0]!.state = "outdated";
    f.rpc.request.mockResolvedValueOnce({ type: "integration_list", integrations: f.integrations }).mockResolvedValueOnce(result);
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("audited only for Herdr 0.9.5");
    expect(f.rpc.request.mock.calls.map(([method]) => method)).toEqual(["integration.list", "ping"]);
  });

  it.each(["codex", "copilot"] as const)("does not read Codex TOML or ping for current %s", async (agent) => {
    const f = await fixture(); await mkdir(path.join(f.codex, "config.toml"));
    await expect(f.preflight.verifyStart(f.input(agent), operation())).resolves.toMatchObject({ agent });
    expect(f.rpc.request.mock.calls.map(([method]) => method)).toEqual(["integration.list"]);
  });

  it("keeps Copilot repair independent of unreadable Codex TOML", async () => {
    const f = await fixture(); f.integrations[1]!.state = "outdated";
    await mkdir(path.join(f.codex, "config.toml"));
    f.rpc.request.mockImplementation(async (method) => {
      if (method === "integration.list") return { type: "integration_list", integrations: f.integrations };
      expect(method).toBe("integration.install"); f.integrations[1]!.state = "current";
      return { type: "integration_install", target: "copilot", details: { messages: [] } };
    });
    await expect(f.preflight.verifyStart(f.input("copilot"), operation())).resolves.toMatchObject({ agent: "copilot" });
    expect(f.rpc.request.mock.calls.map(([method]) => method)).toEqual(["integration.list", "integration.install", "integration.list"]);
  });

  it("guards the explicit CODEX_HOME even with config overrides and a different default home", async () => {
    const f = await fixture(); f.integrations[0]!.state = "not_installed";
    await writeFile(path.join(f.codex, "config.toml"), "features.hooks = false\n");
    const preflight = createHerdrPreflight({ assertIntegrationEnvironment: f.assertIntegrationEnvironment, rpc: f.rpc, environment: { CODEX_HOME: f.codex }, homeDirectory: path.join(f.root, "other home"), runCommand: f.runCommand });
    const input = f.input("codex"); input.configuration.args = ["--config=features.hooks=true"];
    await expect(preflight.verifyStart(input, operation())).rejects.toThrow("Cannot safely install");
    expect(f.rpc.request.mock.calls.map(([method]) => method)).toEqual(["integration.list", "ping"]);
  });

  it("refuses an adopted daemon before reading config or requesting installation", async () => {
    const f = await fixture(); f.integrations[0]!.state = "outdated";
    const failure = new Error("daemon environment is not owned"); f.assertIntegrationEnvironment.mockImplementation(() => { throw failure; });
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toBe(failure);
    expect(f.rpc.request.mock.calls.map(([method]) => method)).toEqual(["integration.list"]);
    expect(f.assertIntegrationEnvironment).toHaveBeenCalledWith(f.codex);
  });

  it("checks daemon ownership again after reading config before sending installation", async () => {
    const f = await fixture(); f.integrations[0]!.state = "outdated";
    await writeFile(path.join(f.codex, "config.toml"), "[features]\nhooks = false\n");
    const failure = new Error("owned daemon exited during configuration read");
    let exited = false;
    f.assertIntegrationEnvironment.mockImplementation(() => { if (exited) throw failure; });
    const op = operation(); const consume = op.consume.bind(op);
    vi.spyOn(op, "consume").mockImplementation((bytes) => { consume(bytes); exited = true; });
    await expect(f.preflight.verifyStart(f.input("codex"), op)).rejects.toBe(failure);
    expect(f.assertIntegrationEnvironment).toHaveBeenCalledTimes(2);
    expect(f.rpc.request.mock.calls.map(([method]) => method)).toEqual(["integration.list", "ping"]);
  });

  it("preserves native read errors and refuses invalid UTF-8 before installation", async () => {
    const f = await fixture(); f.integrations[0]!.state = "outdated";
    const file = path.join(f.codex, "config.toml"); await mkdir(file);
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toMatchObject({ code: "EISDIR" });
    await rm(file, { recursive: true }); await writeFile(file, Buffer.from([0xff]));
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toBeInstanceOf(TypeError);
    expect(f.rpc.request.mock.calls.every(([method]) => method !== "integration.install")).toBe(true);
    expect(await readFile(file)).toEqual(Buffer.from([0xff]));
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")("preserves permission errors rather than treating config as absent", async () => {
    const f = await fixture(); f.integrations[0]!.state = "outdated";
    const file = path.join(f.codex, "config.toml"); await writeFile(file, "[features]\n"); await chmod(file, 0);
    try { await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toMatchObject({ code: "EACCES" }); }
    finally { await chmod(file, 0o600); }
    expect(f.rpc.request.mock.calls.map(([method]) => method)).toEqual(["integration.list", "ping"]);
  });

  it("bounds Codex config bytes and honors cancellation during its read", async () => {
    const f = await fixture(); f.integrations[0]!.state = "outdated";
    const file = path.join(f.codex, "config.toml"); await writeFile(file, "x".repeat(1_048_577));
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("one MiB");
    const controller = new AbortController(); const op = operation({ signal: controller.signal });
    const consume = op.consume.bind(op);
    vi.spyOn(op, "consume").mockImplementation((bytes) => { consume(bytes); controller.abort(new Error("stop config read")); });
    const failure = await f.preflight.verifyStart(f.input("codex"), op).catch((cause: unknown) => cause);
    expect(failure).toBe(op.signal.reason);
    expect(f.rpc.request.mock.calls.every(([method]) => method !== "integration.install")).toBe(true);
  });

  it.each([
    { type: "wrong", integrations: [] },
    { type: "integration_list", integrations: null },
    { type: "integration_list", integrations: [] },
    { type: "integration_list", integrations: [null] },
    ...["target", "label", "command", "available", "state"].map((key) => {
      const info: Record<string, unknown> = { target: "codex", label: "Codex", command: "codex", available: true, state: "outdated" };
      delete info[key]; return { type: "integration_list", integrations: [info] };
    }),
    { type: "integration_list", integrations: [{ target: "codex", label: "Codex", command: "codex", available: true, state: "enabled" }] },
    { type: "integration_list", integrations: [{ target: "codex", label: "Codex", command: "codex", available: "true", state: "outdated" }] },
  ])("rejects invalid integration inventory without writing (%j)", async (result) => {
    const f = await fixture(); f.rpc.request.mockResolvedValueOnce(result);
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow(/integration metadata/);
    expect(f.rpc.request).toHaveBeenCalledTimes(1); expect(f.runCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate targets before writing", async () => {
    const f = await fixture(); f.integrations[0]!.state = "outdated"; f.integrations.push({ ...f.integrations[0]! });
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("invalid integration metadata");
    expect(f.rpc.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: "ok" },
    { type: "integration_install", target: "copilot", details: { messages: [] } },
    { type: "integration_install", target: "codex" },
    { type: "integration_install", target: "codex", details: null },
    { type: "integration_install", target: "codex", details: {} },
    { type: "integration_install", target: "codex", details: { messages: "installed" } },
    { type: "integration_install", target: "codex", details: { messages: [true] } },
  ])("rejects malformed installation acknowledgement without replay (%j)", async (result) => {
    const f = await fixture(); f.integrations[0]!.state = "outdated";
    f.rpc.request.mockResolvedValueOnce({ type: "integration_list", integrations: f.integrations }).mockResolvedValueOnce(pong).mockResolvedValueOnce(result);
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow(/integration install result/);
    expect(f.rpc.request).toHaveBeenCalledTimes(3); expect(f.runCommand).toHaveBeenCalledTimes(1);
  });

  it.each(["not_installed", "outdated"])("requires fresh current state after installation, received %s", async (state) => {
    const f = await fixture(); f.integrations[0]!.state = state;
    f.rpc.request.mockResolvedValueOnce({ type: "integration_list", integrations: f.integrations })
      .mockResolvedValueOnce(pong).mockResolvedValueOnce({ type: "integration_install", target: "codex", details: { messages: [] } });
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("not current after installation");
    expect(f.rpc.request).toHaveBeenCalledTimes(4); expect(f.runCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed post-install inventory without reinstalling", async () => {
    const f = await fixture(); f.integrations[0]!.state = "outdated";
    f.rpc.request.mockResolvedValueOnce({ type: "integration_list", integrations: f.integrations })
      .mockResolvedValueOnce(pong).mockResolvedValueOnce({ type: "integration_install", target: "codex", details: { messages: [] } })
      .mockResolvedValueOnce({ type: "integration_list", integrations: [] });
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("does not contain the codex target");
    expect(f.rpc.request).toHaveBeenCalledTimes(4); expect(f.runCommand).toHaveBeenCalledTimes(1);
  });

  it.each(["codex", "copilot"] as const)("still rejects ineffective %s hooks after successful official installation", async (agent) => {
    const f = await fixture(); const info = f.integrations.find((item) => item.target === agent)!; info.state = "outdated";
    f.rpc.request.mockImplementation(async (method) => {
      if (method === "integration.list") return { type: "integration_list", integrations: f.integrations };
      if (method === "ping") return pong;
      info.state = "current";
      if (agent === "codex") await writeFile(path.join(f.codex, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
      else f.hooks.sessionStart = [];
      return { type: "integration_install", target: agent, details: { messages: [] } };
    });
    await expect(f.preflight.verifyStart(f.input(agent), operation())).rejects.toThrow("does not invoke");
    expect(f.rpc.request).toHaveBeenCalledTimes(agent === "codex" ? 4 : 3);
  });

  it("preserves official install errors that may follow partial writes", async () => {
    const f = await fixture(); f.integrations[0]!.state = "not_installed";
    const failure = new HerdrRpcError("hook registration failed", { method: "integration.install", requestId: id, submission: "unknown", code: "integration_install_failed", apiMessage: "hook registration failed" });
    f.rpc.request.mockResolvedValueOnce({ type: "integration_list", integrations: f.integrations }).mockResolvedValueOnce(pong).mockRejectedValueOnce(failure);
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toBe(failure);
    expect(f.rpc.request).toHaveBeenCalledTimes(3);
  });

  it.each(["integration.list", "integration.install", "post-install read"])("preserves the original %s error without replay", async (stage) => {
    const f = await fixture(); f.integrations[0]!.state = "outdated";
    const failure = new HerdrRpcError("installation outcome unknown", { method: stage, requestId: id, submission: "unknown" });
    if (stage !== "integration.list") f.rpc.request.mockResolvedValueOnce({ type: "integration_list", integrations: f.integrations });
    if (stage === "integration.install") f.rpc.request.mockResolvedValueOnce(pong);
    if (stage === "post-install read") f.rpc.request.mockResolvedValueOnce(pong).mockResolvedValueOnce({ type: "integration_install", target: "codex", details: { messages: [] } });
    f.rpc.request.mockRejectedValueOnce(failure);
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toBe(failure);
    expect(f.rpc.request).toHaveBeenCalledTimes(stage === "integration.list" ? 1 : stage === "integration.install" ? 3 : 4);
    expect(f.runCommand).toHaveBeenCalledTimes(1);
  });

  it.each(["integration.list", "ping", "integration.install"])("honors cancellation after %s before issuing another RPC", async (stage) => {
    const f = await fixture(); f.integrations[0]!.state = "outdated";
    const controller = new AbortController(); const op = operation({ signal: controller.signal });
    f.rpc.request.mockImplementation(async (method): Promise<HerdrRpcResult> => {
      if (method === stage) controller.abort(new Error("stop integration repair"));
      return method === "integration.list" ? { type: "integration_list", integrations: f.integrations } : method === "ping" ? pong : { type: "integration_install", target: "codex", details: { messages: [] } };
    });
    const failure = await f.preflight.verifyStart(f.input("codex"), op).catch((cause: unknown) => cause);
    expect(failure).toBe(op.signal.reason);
    expect(f.rpc.request).toHaveBeenCalledTimes(stage === "integration.list" ? 1 : stage === "ping" ? 2 : 3);
    expect(f.runCommand).toHaveBeenCalledTimes(1);
  });

  it("honors the shared deadline before installation", async () => {
    const f = await fixture(); f.integrations[0]!.state = "outdated";
    const op = operation({ limits: { totalMs: 20 } });
    f.rpc.request.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { type: "integration_list", integrations: f.integrations };
    });
    const failure = await f.preflight.verifyStart(f.input("codex"), op).catch((cause: unknown) => cause);
    expect(failure).toBe(op.signal.reason); expect(failure).toMatchObject({ kind: "deadline" });
    expect(f.rpc.request).toHaveBeenCalledTimes(1);
  });

  it("refuses Codex without isolated execution or enabled hooks", async () => {
    const f = await fixture();
    const original = f.runCommand.getMockImplementation()!;
    f.runCommand.mockImplementation(async (command) => command.args.includes("--help") ? { stdout: "no relevant capability", stderr: "" } : original(command));
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("lacks --no-daemon");
    f.runCommand.mockImplementation(async (command) => command.args.at(-2) === "features" ? { stdout: "hooks stable false", stderr: "" } : original(command));
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
    await expect(f.preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("configure that hook");
  });

  it("resolves the explicit native home without changing the supplied environment", async () => {
    const f = await fixture(); const environment = { CODEX_HOME: f.codex, CODEX_SQLITE_HOME: path.join(f.root, "separate database"), COPILOT_HOME: f.copilot, XDG_CONFIG_HOME: "ignored-by-native-roots" };
    const before = { ...environment }; const preflight = createHerdrPreflight({ assertIntegrationEnvironment: f.assertIntegrationEnvironment, rpc: f.rpc, environment, homeDirectory: f.home, platform: "linux", runCommand: f.runCommand });
    const result = await preflight.verifyStart(f.input("codex"), operation()); expect(result.nativeHome).toBe(environment.CODEX_HOME); expect(environment).toEqual(before);
  });

  it.each(["", "relative", "~/.codex"])("rejects ambiguous native home override %s", async (CODEX_HOME) => {
    const f = await fixture(); const preflight = createHerdrPreflight({ assertIntegrationEnvironment: f.assertIntegrationEnvironment, rpc: f.rpc, environment: { CODEX_HOME }, homeDirectory: f.home, runCommand: f.runCommand });
    await expect(preflight.verifyStart(f.input("codex"), operation())).rejects.toThrow("absolute path"); expect(f.runCommand).not.toHaveBeenCalled();
  });

  it.each(["codex", "copilot"] as const)("checks %s resume prerequisites without inspecting native history", async (agent) => {
    const f = await fixture();
    expect(await f.preflight.verifyStart(f.input(agent, id), operation())).toMatchObject({ agent, integrationConfigured: true });
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
  f.integrations.push({ target: "claude", label: "Claude", command: "claude", available: true, state: "current" });
  const original = f.runCommand.getMockImplementation()!; f.runCommand.mockImplementation(async command => command.file === "claude" ? { stdout: command.args.includes("--help") ? "--dangerously-skip-permissions" : "2.1.247 (Claude Code)\n", stderr: "" } : original(command));
  const input = { context: { cwd: f.cwd }, configuration: { agent: "claude" as const, model: null, args: [] } };
  expect(await f.preflight.verifyStart(input, operation())).toMatchObject({ agent: "claude", version: "2.1.247", nativeHome: root });
  await mkdir(path.join(f.cwd, ".claude")); await writeFile(path.join(f.cwd, ".claude", "settings.local.json"), JSON.stringify({ disableAllHooks: true }));
  await expect(f.preflight.verifyStart(input, operation())).rejects.toThrow(/disabled/);
});
