import { beforeEach, expect, it, vi } from "vitest";
import { inspectNativeSelection } from "../../../src/commands/worker/native-selection-probe.js";

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
