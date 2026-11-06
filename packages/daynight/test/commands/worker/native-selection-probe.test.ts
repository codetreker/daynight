import { beforeEach, expect, it, vi } from "vitest";
import { inspectNativeSelection } from "../../../src/commands/worker/native-selection-probe.js";
import { withCodexConfigurationRpc } from "../../../src/commands/worker/herdr/codex-config.js";

vi.mock("../../../src/commands/worker/herdr/codex-config.js", () => ({ withCodexConfigurationRpc: vi.fn() }));

const mocks = vi.hoisted(() => ({ current: vi.fn(), list: vi.fn(), disconnect: vi.fn(), create: vi.fn(), stop: vi.fn(), options: [] as unknown[] }));
vi.mock("which", () => ({ default: async () => "/native/copilot" }));
vi.mock("@github/copilot-sdk", () => ({
  RuntimeConnection: { forStdio: (value: unknown) => value },
  CopilotClient: class {
    constructor(options: unknown) { mocks.options.push(options); }
    start = async () => {};
    createSession = mocks.create;
    stop = mocks.stop;
  },
}));
beforeEach(() => {
  vi.resetAllMocks(); mocks.options.length = 0;
  mocks.current.mockResolvedValue({ modelId: "native-model", reasoningEffort: "high" });
  mocks.list.mockResolvedValue({ list: [{ id: "native-model", supportedReasoningEfforts: ["low", "high"] }] });
  mocks.disconnect.mockResolvedValue(undefined); mocks.stop.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ rpc: { model: { getCurrent: mocks.current, list: mocks.list } }, disconnect: mocks.disconnect });
});

it("validates effort-only against the model resolved by a no-input, memory-backed native session", async () => {
  expect(await inspectNativeSelection({ agent: "copilot", model: null, args: ["--reasoning-effort", "high"] })).toMatchObject({ model: "native-model", effort: "high" });
  expect(mocks.options[0]).toMatchObject({ workingDirectory: process.cwd(), sessionFs: { initialCwd: process.cwd(), capabilities: { sqlite: false } } });
  expect(mocks.create.mock.calls[0]![0]).toMatchObject({ workingDirectory: process.cwd(), reasoningEffort: "high", createSessionFsProvider: expect.any(Function) });
  expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty("model");
  expect(mocks.disconnect).toHaveBeenCalledOnce(); expect(mocks.stop).toHaveBeenCalledOnce();
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

it("resolves Codex's omitted model from its native default without adding a launch model", async () => {
  const request = vi.fn(async (method: string, parameters: unknown) => {
    if (method === "config/read") return { config: { model: null, model_reasoning_effort: "high" } };
    if (method === "model/list") return { data: [{ model: "other", isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }, { model: "native-default", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }], nextCursor: null };
    throw new Error(`Unexpected native method ${method}: ${JSON.stringify(parameters)}`);
  });
  vi.mocked(withCodexConfigurationRpc).mockImplementation(async (_options, _operation, read) => read({ request } as never));
  expect(await inspectNativeSelection({ agent: "codex", model: null, args: ["-c", 'model_reasoning_effort="high"'] })).toMatchObject({ model: "native-default", effort: "high" });
  expect(vi.mocked(withCodexConfigurationRpc).mock.calls[0]![0].args).toEqual(["-c", 'model_reasoning_effort="high"']);
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
