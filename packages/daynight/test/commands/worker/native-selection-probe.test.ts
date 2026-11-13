import { beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { inspectNativeSelection, inspectNativeCapabilities } from "../../../src/commands/worker/native-selection-probe.js";
import { withCodexConfigurationRpc } from "../../../src/commands/worker/herdr/codex-config.js";
import { HerdrCommandCleanupError } from "../../../src/commands/worker/herdr/command.js";
import { buildHerdrAgentArguments, codexConfigurationArguments, codexProjectTrustArguments } from "../../../src/commands/worker/herdr/arguments.js";
import { ToolSelectionError } from "../../../src/platform/tool-executables.js";

vi.mock("../../../src/commands/worker/herdr/codex-config.js", () => ({ withCodexConfigurationRpc: vi.fn() }));


const mocks = vi.hoisted(() => ({ current: vi.fn(), list: vi.fn(), disconnect: vi.fn(), create: vi.fn(), stop: vi.fn(), forceStop: vi.fn(), options: [] as unknown[], runtimeClose: vi.fn(), runtimeStart: vi.fn(), claude: vi.fn(), claudeModels: vi.fn(), claudeSettings: vi.fn(), claudeClose: vi.fn() }));
vi.mock("../../../src/commands/controller/providers/copilot-owned-process.js", () => ({
  copilotDeadline: (promise: Promise<unknown>) => promise,
  startCopilotProcess: mocks.runtimeStart,
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mocks.claude }));
vi.mock("which", () => ({ default: async () => "/native/copilot" }));
vi.mock("@github/copilot-sdk", () => ({
  RuntimeConnection: { forStdio: (value: unknown) => value, forUri: (uri: string, value: unknown) => ({ uri, ...value as object }) },
  CopilotClient: class {
    constructor(options: unknown) { mocks.options.push(options); }
    start = async () => {};
    getStatus = async () => ({ version: "1.0.105", protocolVersion: 1 });
    rpc = { runtime: { shutdown: async () => ({}) } };
    forceStop = mocks.forceStop;
    createSession = mocks.create;
    stop = mocks.stop;
  },
}));
beforeEach(() => {
  vi.resetAllMocks(); mocks.options.length = 0;
  mocks.runtimeClose.mockResolvedValue(undefined);
  mocks.forceStop.mockResolvedValue(undefined);
  mocks.runtimeStart.mockReturnValue({ ready: Promise.resolve({ port: 12345, token: "fixture-token" }), failed: new Promise(() => {}), close: mocks.runtimeClose });
  mocks.current.mockResolvedValue({ modelId: "native-model", reasoningEffort: "high" });
  mocks.list.mockResolvedValue({ list: [{ id: "native-model", supportedReasoningEfforts: ["low", "high"] }] });
  mocks.disconnect.mockResolvedValue(undefined); mocks.stop.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ rpc: { model: { getCurrent: mocks.current, list: mocks.list } }, disconnect: mocks.disconnect });
  mocks.claude.mockReturnValue({ initializationResult: async () => ({}), supportedModels: mocks.claudeModels, getSettings: mocks.claudeSettings, close: mocks.claudeClose });
});

it("validates effort-only against the model resolved by a no-input, memory-backed native session", async () => {
  expect(await inspectNativeSelection({ agent: "copilot", model: null, args: ["--reasoning-effort", "high"] })).toMatchObject({ model: "native-model", effort: "high" });
  expect(mocks.options[0]).toMatchObject({ workingDirectory: process.cwd(), sessionFs: { initialCwd: process.cwd(), capabilities: { sqlite: false } } });
  expect(mocks.create.mock.calls[0]![0]).toMatchObject({ workingDirectory: process.cwd(), reasoningEffort: "high", createSessionFsProvider: expect.any(Function) });
  expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty("model");
  expect(mocks.disconnect).toHaveBeenCalledOnce(); expect(mocks.stop).toHaveBeenCalledOnce();
});

it("returns Copilot capabilities when its effective default model cannot be confirmed", async () => {
  mocks.current.mockResolvedValue({ reasoningEffort: "high" });
  mocks.list.mockResolvedValue({ list: [{ id: "native-model", name: "Native model", supportedReasoningEfforts: ["low", "high"] }, { id: "plain", capabilities: { supports: { reasoning_effort: [] } } }] });
  expect(await inspectNativeCapabilities({ agent: "copilot", model: null, args: [] })).toEqual({ model: null, effort: "high", models: [
    { id: "native-model", label: "Native model", hidden: false, efforts: ["low", "high"], defaultEffort: null },
    { id: "plain", label: "plain", hidden: false, efforts: [], defaultEffort: null },
  ] });
  expect(mocks.disconnect).toHaveBeenCalledOnce(); expect(mocks.stop).toHaveBeenCalledOnce();
});

it("preserves Codex hidden capabilities and each model's native effort default", async () => {
  const request = vi.fn(async (method: string) => method === "config/read" ? { config: { model: "secret" } } : { data: [
    { model: "secret", displayName: "Hidden native model", hidden: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high" },
    { model: "plain", supportedReasoningEfforts: [] },
  ], nextCursor: null });
  vi.mocked(withCodexConfigurationRpc).mockImplementation(async (_options, _operation, read) => read({ request } as never));
  expect(await inspectNativeCapabilities({ agent: "codex", model: null, args: [] })).toEqual({ model: "secret", models: [
    { id: "secret", label: "Hidden native model", hidden: true, efforts: ["high"], defaultEffort: "high" },
    { id: "plain", label: "plain", hidden: false, efforts: [], defaultEffort: null },
  ] });
});

it("preserves a changed frozen tool identity detected inside the capability child", async () => {
  const failure = new ToolSelectionError("codex", "web", "verify", "tool_identity_changed");
  vi.mocked(withCodexConfigurationRpc).mockRejectedValue(failure);
  await expect(inspectNativeCapabilities({ agent: "codex", model: null, args: [] })).rejects.toBe(failure);
});

it("reads the Copilot model's native effort default without treating current effort as its default", async () => {
  mocks.list.mockResolvedValue({ list: [{ id: "native-model", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" }] });
  expect(await inspectNativeCapabilities({ agent: "copilot", model: null, args: [] })).toMatchObject({ effort: "high", models: [{ defaultEffort: "low" }] });
});

it("preserves Claude aliases and unsupported effort without guessing native defaults", async () => {
  mocks.claudeModels.mockResolvedValue([{ value: "alias", displayName: "Alias", resolvedModel: "native-model", supportsEffort: true, supportedEffortLevels: ["low", "max"] }, { value: "plain", displayName: "Plain", supportsEffort: false }]);
  mocks.claudeSettings.mockResolvedValue({ applied: { model: "native-model", effort: null } });
  expect(await inspectNativeCapabilities({ agent: "claude", model: null, args: [] })).toEqual({ model: "native-model", effort: null, models: [
    { id: "alias", label: "Alias", aliases: ["native-model"], hidden: false, efforts: ["low", "max"], defaultEffort: null },
    { id: "plain", label: "Plain", aliases: [], hidden: false, efforts: null, defaultEffort: null },
  ] });
  const options = mocks.claude.mock.calls[0]![0];
  expect(options.options.persistSession).toBe(false);
  expect(options.prompt[Symbol.asyncIterator]).toEqual(expect.any(Function));
  expect(options.options).not.toHaveProperty("resume");
  expect(options.options).not.toHaveProperty("pathToClaudeCodeExecutable");
  expect(mocks.claudeClose).toHaveBeenCalledOnce();
});

it("uses an owned Web headless connection and preserves the legacy Herdr stdio probe", async () => {
  await inspectNativeCapabilities({ agent: "copilot", model: null, args: [] });
  await inspectNativeSelection({ agent: "copilot", model: null, args: [] });
  expect(mocks.options[0]).toMatchObject({ connection: { uri: "127.0.0.1:12345", connectionToken: "fixture-token" } });
  expect(mocks.options[1]).toMatchObject({ connection: { path: "/native/copilot" } });
  expect(mocks.runtimeClose).toHaveBeenCalledOnce();
});

it.each([1, "", "x".repeat(4097)])("rejects a malformed Codex page cursor", async nextCursor => {
  const request = vi.fn(async (method: string) => method === "config/read" ? { config: { model: null } } : { data: [{ model: "native-model" }], nextCursor });
  vi.mocked(withCodexConfigurationRpc).mockImplementation(async (_options, _operation, read) => read({ request } as never));
  await expect(inspectNativeCapabilities({ agent: "codex", model: null, args: [] })).rejects.toMatchObject({ code: "capability_error" });
  expect(request.mock.calls).toHaveLength(2);
});

it.each([
  { list: [{ id: "duplicate" }, { id: "duplicate" }], code: "capability_error" },
  { list: [{ id: "" }], code: "capability_error" },
  { list: [{ id: "invalid", supportedReasoningEfforts: [1] }], code: "capability_error" },
  { list: Array.from({ length: 501 }, (_, index) => ({ id: `model-${index}` })), code: "limit_exceeded" },
  { list: [{ id: "huge", name: "x".repeat(65536) }], code: "limit_exceeded" },
])("rejects invalid or oversized native capability output: $code", async ({ list, code }) => {
  mocks.list.mockResolvedValue({ list });
  await expect(inspectNativeCapabilities({ agent: "copilot", model: null, args: [] })).rejects.toMatchObject({ code });
  expect(mocks.disconnect).toHaveBeenCalledOnce(); expect(mocks.stop).toHaveBeenCalledOnce();
});

it("retains discovery failure when native disconnect and client shutdown also fail", async () => {
  mocks.current.mockRejectedValue(new Error("network failed"));
  mocks.disconnect.mockRejectedValue(new Error("disconnect failed"));
  mocks.stop.mockResolvedValue([new Error("stop failed")]);
  mocks.forceStop.mockRejectedValue(new Error("transport cleanup failed"));
  await expect(inspectNativeCapabilities({ agent: "copilot", model: null, args: [] })).rejects.toMatchObject({ code: "cleanup_unknown", errors: [expect.objectContaining({ errors: [expect.objectContaining({ message: "network failed" }), expect.objectContaining({ message: "disconnect failed" })] }), expect.objectContaining({ message: "stop failed" }), expect.objectContaining({ message: "transport cleanup failed" })] });
});

it("preserves Codex's unconfirmed inner process cleanup", async () => {
  const cleanup = new HerdrCommandCleanupError([new Error("process still open")], new Error("native timed out"));
  vi.mocked(withCodexConfigurationRpc).mockRejectedValue(cleanup);
  await expect(inspectNativeCapabilities({ agent: "codex", model: null, args: [] })).rejects.toMatchObject({ code: "cleanup_unknown", cause: cleanup });
});

it.each([{ modelId: undefined, reasoningEffort: "high" }, { modelId: "native-model", reasoningEffort: "low" }])("rejects unresolved or unapplied native settings and closes the session", async current => {
  mocks.current.mockResolvedValue(current);
  await expect(inspectNativeSelection({ agent: "copilot", model: null, args: ["--reasoning-effort", "high"] })).rejects.toThrow();
  expect(mocks.disconnect).toHaveBeenCalledOnce(); expect(mocks.stop).toHaveBeenCalledOnce();
});

it("stops the client even when session discovery or disconnect fails", async () => {
  mocks.current.mockRejectedValue(new Error("discovery failed"));
  await expect(inspectNativeSelection({ agent: "copilot", model: null, args: [] })).rejects.toThrow("discovery failed");
  expect(mocks.disconnect).toHaveBeenCalledOnce(); expect(mocks.stop).toHaveBeenCalledOnce();
});

it("does not validate Codex local providers against a different catalog", async () => {
  await expect(inspectNativeSelection({ agent: "codex", model: "local", args: ["--oss"] })).rejects.toThrow("local-provider");
});

it("uses the trusted project model and complete launch configuration when only effort is overridden", async () => {
  const cwd = path.normalize(await realpath(process.cwd()));
  const native = { agent: "codex" as const, model: null, args: ["--profile", "work", "-c", 'model_reasoning_effort="max"'] };
  vi.mocked(withCodexConfigurationRpc).mockImplementation(async (options, _operation, read) => {
    const trusted = options.args.includes(codexProjectTrustArguments(cwd).at(-1)!);
    const request = vi.fn(async (method: string) => method === "config/read" ? { config: { model: trusted ? "project-model" : "user-model", model_reasoning_effort: "max" } }
      : { data: [{ model: "user-model", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }, { model: "project-model", supportedReasoningEfforts: [{ reasoningEffort: "max" }] }], nextCursor: null });
    return read({ request } as never);
  });
  expect(await inspectNativeSelection(native)).toMatchObject({ model: "project-model", effort: "max" });
  const inspected = vi.mocked(withCodexConfigurationRpc).mock.calls[0]![0];
  expect(inspected.cwd).toBe(cwd);
  expect(codexConfigurationArguments(inspected.args)).toEqual(codexConfigurationArguments(buildHerdrAgentArguments(native, cwd)));
  expect(inspected.args).not.toContain("--model");
});

it("uses Web configuration trust for discovery while preserving Herdr launch trust for verification", async () => {
  const cwd = path.normalize(await realpath(process.cwd()));
  vi.mocked(withCodexConfigurationRpc).mockImplementation(async (options, _operation, read) => {
    const trusted = options.args.includes(codexProjectTrustArguments(cwd).at(-1)!);
    return read({ request: async (method: string) => method === "config/read" ? { config: { model: trusted ? "project-model" : "user-model" } } : { data: [{ model: "user-model" }, { model: "project-model" }], nextCursor: null } } as never);
  });
  const native = { agent: "codex" as const, model: null, args: [] };
  expect((await inspectNativeCapabilities(native)).model).toBe("user-model");
  expect(vi.mocked(withCodexConfigurationRpc).mock.calls[0]![0].args).toEqual([]);
  expect((await inspectNativeSelection(native)).model).toBe("project-model");
});

it("uses only explicit model and effort config overrides for Web discovery", async () => {
  const request = vi.fn(async (method: string) => method === "config/read" ? { config: { model: "selected", model_reasoning_effort: "high" } } : { data: [{ model: "selected", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null });
  vi.mocked(withCodexConfigurationRpc).mockImplementation(async (_options, _operation, read) => read({ request } as never));
  expect((await inspectNativeCapabilities({ agent: "codex", model: "selected", args: ["--effort", "high", "--sandbox", "read-only"] })).effort).toBe("high");
  expect(vi.mocked(withCodexConfigurationRpc).mock.calls[0]![0].args).toEqual(["-c", 'model_reasoning_effort="high"', "-c", 'model="selected"']);
  await expect(inspectNativeCapabilities({ agent: "codex", model: null, args: ["--profile", "unsupported-web-profile"] })).rejects.toThrow("Web");
  expect(vi.mocked(withCodexConfigurationRpc)).toHaveBeenCalledOnce();
});

it("uses the canonical launch directory for project trust and configuration inspection", async () => {
  const original = process.cwd(), canonical = path.normalize(await realpath(original));
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp");
  await mkdir(scratch, { recursive: true });
  const temporary = await mkdtemp(path.join(scratch, "selection-cwd-")), alias = path.join(temporary, "alias");
  await symlink(original, alias, process.platform === "win32" ? "junction" : "dir");
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(alias);
  const request = vi.fn(async (method: string) => method === "config/read" ? { config: { model: "native-model" } } : { data: [{ model: "native-model", supportedReasoningEfforts: [] }], nextCursor: null });
  vi.mocked(withCodexConfigurationRpc).mockImplementation(async (_options, _operation, read) => read({ request } as never));
  try {
    await inspectNativeSelection({ agent: "codex", model: null, args: [] });
    const inspected = vi.mocked(withCodexConfigurationRpc).mock.calls[0]![0];
    expect(inspected.cwd).toBe(canonical);
    expect(inspected.args).toContain(codexProjectTrustArguments(canonical).at(-1));
    expect(request).toHaveBeenCalledWith("config/read", { cwd: canonical, includeLayers: false });
  } finally { cwd.mockRestore(); await rm(temporary, { recursive: true, force: true }); }
});

it("resolves Codex's omitted model from its native default without adding a launch model", async () => {
  const request = vi.fn(async (method: string, parameters: unknown) => {
    if (method === "config/read") return { config: { model: null, model_reasoning_effort: "high" } };
    if (method === "model/list") return { data: [{ model: "other", isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }, { model: "native-default", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null };
    throw new Error(`Unexpected native method ${method}: ${JSON.stringify(parameters)}`);
  });
  vi.mocked(withCodexConfigurationRpc).mockImplementation(async (_options, _operation, read) => read({ request } as never));
  expect(await inspectNativeSelection({ agent: "codex", model: null, args: ["-c", 'model_reasoning_effort="high"'] })).toMatchObject({ model: "native-default", effort: "high" });
  expect(vi.mocked(withCodexConfigurationRpc).mock.calls[0]![0].args).toEqual(buildHerdrAgentArguments({ agent: "codex", model: null, args: ["-c", 'model_reasoning_effort="high"'] }, path.normalize(await realpath(process.cwd()))));
  expect(request.mock.calls.every(([method]) => method === "config/read" || method === "model/list")).toBe(true);
});

it("validates a configured hidden Codex model using the complete native catalog", async () => {
  const request = vi.fn(async (method: string, parameters: unknown) => {
    if (method === "config/read") return { config: { model: "hidden-model", model_reasoning_effort: "high" } };
    const { cursor, includeHidden } = parameters as { cursor?: string; includeHidden?: boolean };
    return cursor === undefined ? { data: [{ model: "native-default", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: "second" }
      : { data: includeHidden ? [{ model: "hidden-model", hidden: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] : [], nextCursor: null };
  });
  vi.mocked(withCodexConfigurationRpc).mockImplementation(async (_options, _operation, read) => read({ request } as never));
  expect(await inspectNativeSelection({ agent: "codex", model: "hidden-model", args: ["-c", 'model_reasoning_effort="high"'] })).toMatchObject({ model: "hidden-model", effort: "high" });
  expect(codexConfigurationArguments(vi.mocked(withCodexConfigurationRpc).mock.calls[0]![0].args).arguments).toContain('model="hidden-model"');
  expect(request.mock.calls.filter(([method]) => method === "model/list").map(([, parameters]) => parameters)).toEqual([{ includeHidden: true }, { includeHidden: true, cursor: "second" }]);
});

it.each([
  { configured: "configured", catalog: [{ model: "first", isDefault: true }, { model: "configured" }], expected: "configured" },
  { configured: null, catalog: [{ model: "first" }, { model: "second" }], expected: "first" },
  { configured: null, catalog: [{ model: "first", isDefault: true }, { model: "second", isDefault: true }], expected: "first" },
])("preserves native default selection order: $expected", async ({ configured, catalog, expected }) => {
  const request = vi.fn(async (method: string) => method === "config/read" ? { config: { model: configured, model_reasoning_effort: "high" } }
    : { data: catalog.map(item => ({ ...item, supportedReasoningEfforts: [{ reasoningEffort: "high" }] })), nextCursor: null });
  vi.mocked(withCodexConfigurationRpc).mockImplementation(async (_options, _operation, read) => read({ request } as never));
  expect(await inspectNativeSelection({ agent: "codex", model: null, args: ["-c", 'model_reasoning_effort="high"'] })).toMatchObject({ model: expected, effort: "high" });
});

it.each(["empty", "oversized", "cycle"])("rejects a Codex %s catalog without creating a conversation", async kind => {
  const request = vi.fn(async (method: string) => method === "config/read" ? { config: { model: null, model_reasoning_effort: "high" } }
    : { data: kind === "oversized" ? Array.from({ length: 501 }, (_, index) => ({ model: `hidden-${index}`, hidden: true })) : [], nextCursor: kind === "cycle" ? "same" : null });
  vi.mocked(withCodexConfigurationRpc).mockImplementation(async (_options, _operation, read) => read({ request } as never));
  await expect(inspectNativeSelection({ agent: "codex", model: null, args: ["-c", 'model_reasoning_effort="high"'] })).rejects.toThrow(kind === "empty" ? "unknown" : "bound");
  expect(request.mock.calls.every(([method]) => method === "config/read" || method === "model/list")).toBe(true);
});
