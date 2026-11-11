import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkerCloudNative } from "../../../../src/api/worker-configuration.js";
import type { WorkerRuntimeNative } from "../../../../src/api/types.js";
import type { Operation } from "../../../../src/api/operation.js";
import type { NativeModelObservation } from "../../../../src/commands/controller/providers/native-selection.js";
import { BotCliProbeCleanupError } from "../../../../src/commands/worker/bots/cli-probe.js";
import { createWorkerModelDiscovery, parseWorkerModelInput } from "../../../../src/commands/worker/read-only/models.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const base = (): { native: WorkerCloudNative; report: WorkerRuntimeNative } => ({
  native: { agent: "codex", model: null, args: [] },
  report: { agent: "codex", model: { value: null, source: "native" }, reasoningEffort: { value: null, source: "native" } },
});
const observation = (): NativeModelObservation => ({ model: "a", models: [
  { id: "a", label: "Model A", hidden: false, efforts: ["low", "high"], defaultEffort: "low" },
  { id: "hidden", label: "Hidden", hidden: true, efforts: null },
  { id: "b", label: "Model B", efforts: ["high"] },
] });
const setup = async (overrides: { prepare?: Parameters<typeof createWorkerModelDiscovery>[0]["prepare"]; inspect?: (native: WorkerCloudNative, operation: Operation) => Promise<NativeModelObservation>; configuration?: () => ReturnType<typeof base> } = {}) => {
  const temporary = path.resolve("../../.tmp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "worker-models-")); roots.push(root);
  const calls: WorkerCloudNative[] = [];
  const service = createWorkerModelDiscovery({ ...(overrides.prepare === undefined ? {} : { prepare: overrides.prepare }), defaultCwd: root, environment: {}, configuration: overrides.configuration ?? base,
    verifier: { discover: async (options, operation) => { operation.check(); calls.push(options.native); return overrides.inspect?.(options.native, operation) ?? observation(); } },
  });
  return { service, root: await realpath(root), calls, signal: new AbortController().signal };
};

describe("Worker model discovery", () => {
  it("captures the prepared recipe identity before pagination and rejects pages after a tool change", async () => {
    let selected: string | null = null;
    const prepare = vi.fn(async () => { selected = "A"; });
    const { service, signal } = await setup({ prepare, configuration: () => ({ ...base(), toolSelection: selected }) });
    const first = await service.discover({ provider: "codex", limit: 1 }, signal);
    expect(first.nextCursor).not.toBeNull(); expect(prepare).toHaveBeenCalledOnce();
    await service.discover({ provider: "codex", limit: 1, cursor: first.nextCursor! }, signal);
    expect(prepare).toHaveBeenCalledOnce(); selected = "B";
    await expect(service.discover({ provider: "codex", limit: 1, cursor: first.nextCursor! }, signal)).rejects.toMatchObject({ code: "stale_configuration" });
  });

  it("reads native per-model capabilities, hides optional entries and retains native defaults", async () => {
    const { service, root, calls, signal } = await setup();
    const result = await service.discover({ provider: "codex" }, signal);
    expect(result).toMatchObject({ schemaVersion: 1, provider: "codex", cwd: root, models: [
      { id: "a", label: "Model A", aliases: [], hidden: false, reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" },
      { id: "b", reasoningEfforts: ["high"], defaultReasoningEffort: null },
    ], defaults: { model: { value: "a", source: "native" }, reasoningEffort: { value: "low", source: "native" } }, selectionError: null, nextCursor: null });
    expect(result.configurationGeneration).toMatch(/^[0-9a-f]{64}$/);
    expect(result.catalogGeneration).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toHaveLength(1);
  });

  it("keeps a hidden effective default and unsupported effort models without inventing effort", async () => {
    const { service, signal } = await setup({ inspect: async () => ({ ...observation(), model: "hidden" }) });
    const result = await service.discover({ provider: "codex" }, signal);
    expect(result.defaults).toEqual({ model: { value: "hidden", source: "native" }, reasoningEffort: { value: null, source: "native" } });
    expect(result.selectionError).toBeNull();
    expect(result.models.map(model => model.id)).not.toContain("hidden");
    expect((await service.discover({ provider: "codex", includeHidden: true }, signal)).models).toHaveLength(3);
  });

  it("returns an unknown native default together with a usable catalog", async () => {
    const { service, signal } = await setup({ inspect: async () => ({ ...observation(), model: null, effort: "high" }) });
    const result = await service.discover({ provider: "copilot" }, signal);
    expect(result.defaults.model).toEqual({ value: null, source: "unknown" });
    expect(result.selectionError?.code).toBe("unknown_default");
    expect(result.models).toHaveLength(2);
  });

  it("preserves configured sources and reports incompatible inherited effort", async () => {
    const configuration = base();
    configuration.native = { agent: "codex", model: "a", args: ["--effort", "high"] };
    configuration.report = { agent: "codex", model: { value: "a", source: "local" }, reasoningEffort: { value: "high", source: "cloud" } };
    const { service, signal, calls } = await setup({ configuration: () => configuration, inspect: async native => ({ ...observation(), model: native.model, effort: "high" }) });
    expect((await service.discover({ provider: "codex" }, signal)).defaults).toEqual({ model: { value: "a", source: "local" }, reasoningEffort: { value: "high", source: "cloud" } });
    const selected = await service.discover({ provider: "codex", model: "hidden" }, signal);
    expect(selected.defaults.model).toEqual({ value: "hidden", source: "explicit" });
    expect(selected.defaults.reasoningEffort).toEqual({ value: "high", source: "cloud" });
    expect(selected.selectionError?.code).toBe("unsupported_selection");
    expect(calls[1]).toEqual({ agent: "codex", model: "hidden", args: ["--effort", "high"] });
  });

  it("does not inherit another provider's configured model or effort", async () => {
    const configuration = base();
    configuration.native = { agent: "codex", model: "codex-only", args: ["--effort", "high"] };
    configuration.report = { ...configuration.report, model: { value: "codex-only", source: "local" } };
    const { service, signal, calls } = await setup({ configuration: () => configuration });
    await service.discover({ provider: "claude" }, signal);
    expect(calls).toEqual([{ agent: "claude", model: null, args: [] }]);
  });

  it("keeps a single bounded snapshot across pages and refreshes first-page reads", async () => {
    const { service, signal, calls } = await setup();
    const first = await service.discover({ provider: "codex", limit: 1 }, signal);
    const second = await service.discover({ provider: "codex", limit: 1, cursor: first.nextCursor! }, signal);
    expect(second.models.map(model => model.id)).toEqual(["b"]);
    expect(second.catalogGeneration).toBe(first.catalogGeneration);
    expect(second.nextCursor).toBeNull();
    expect(calls).toHaveLength(1);
    const fresh = await service.discover({ provider: "codex", limit: 1 }, signal);
    expect(fresh.catalogGeneration).not.toBe(first.catalogGeneration);
    expect(calls).toHaveLength(2);
  });

  it("rejects changed selection, filter, limit and fabricated cursors", async () => {
    const { service, signal } = await setup();
    const first = await service.discover({ provider: "codex", limit: 1 }, signal);
    for (const input of [
      { provider: "claude" as const, limit: 1 }, { provider: "codex" as const, limit: 2 },
      { provider: "codex" as const, limit: 1, model: "b" }, { provider: "codex" as const, limit: 1, includeHidden: true },
    ]) await expect(service.discover({ ...input, cursor: first.nextCursor! }, signal)).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(service.discover({ provider: "codex", cursor: "fabricated" }, signal)).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("invalidates pages after effective configuration changes", async () => {
    let configuration = base();
    const { service, signal } = await setup({ configuration: () => configuration });
    const first = await service.discover({ provider: "codex", limit: 1 }, signal);
    configuration = { ...configuration, native: { agent: "codex", model: "b", args: [] } };
    await expect(service.discover({ provider: "codex", limit: 1, cursor: first.nextCursor! }, signal)).rejects.toMatchObject({ code: "stale_configuration" });
  });

  it("invalidates pagination when the owning connection changes", async () => {
    const { service, signal } = await setup();
    const first = await service.discover({ provider: "codex", limit: 1 }, signal);
    service.invalidate();
    await expect(service.discover({ provider: "codex", limit: 1, cursor: first.nextCursor! }, signal)).rejects.toMatchObject({ code: "invalid_cursor" });
    const fresh = await service.discover({ provider: "codex", limit: 1 }, signal);
    expect(fresh.catalogGeneration).not.toBe(first.catalogGeneration);
  });

  it("does not retain a late native catalog after connection invalidation", async () => {
    const { service, signal } = await setup({ inspect: async () => { service.invalidate(); return observation(); } });
    await expect(service.discover({ provider: "codex", limit: 1 }, signal)).rejects.toMatchObject({ code: "stale_configuration" });
  });

  it("discards results when configuration changes during a native query", async () => {
    let configuration = base();
    const { service, signal } = await setup({ configuration: () => configuration, inspect: async () => {
      configuration = { ...configuration, native: { agent: "codex", model: "changed", args: [] } };
      return observation();
    } });
    await expect(service.discover({ provider: "codex" }, signal)).rejects.toMatchObject({ code: "stale_configuration" });
  });

  it("expires pagination snapshots and bounds their number", async () => {
    const { service, signal } = await setup();
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now);
    const first = await service.discover({ provider: "codex", limit: 1 }, signal);
    for (let index = 0; index < 8; index++) await service.discover({ provider: "codex", limit: 1 }, signal);
    await expect(service.discover({ provider: "codex", limit: 1, cursor: first.nextCursor! }, signal)).rejects.toMatchObject({ code: "invalid_cursor" });
    const current = await service.discover({ provider: "codex", limit: 1 }, signal);
    vi.mocked(Date.now).mockReturnValue(now + 30_001);
    await expect(service.discover({ provider: "codex", limit: 1, cursor: current.nextCursor! }, signal)).rejects.toMatchObject({ code: "invalid_cursor" });
    vi.restoreAllMocks();
  });

  it("uses the target directory's canonical path and rejects files or missing directories", async () => {
    const { service, root, signal } = await setup();
    await mkdir(path.join(root, "child"));
    await symlink(path.join(root, "child"), path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    expect((await service.discover({ provider: "codex", cwd: path.join(root, "link") }, signal)).cwd).toBe(path.join(root, "child"));
    await writeFile(path.join(root, "file"), "untouched");
    await expect(service.discover({ provider: "codex", cwd: path.join(root, "file") }, signal)).rejects.toMatchObject({ code: "invalid_path" });
    await expect(service.discover({ provider: "codex", cwd: path.join(root, "absent") }, signal)).rejects.toMatchObject({ code: "not_found" });
  });

  it("does not return a native result after cancellation", async () => {
    const controller = new AbortController();
    const { service } = await setup({ inspect: async () => { controller.abort(); return observation(); } });
    await expect(service.discover({ provider: "codex" }, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });

  it("retains cleanup ownership in an explicit cleanup_unknown cause", async () => {
    const original = new BotCliProbeCleanupError({ launchId: "owned", pid: 42, process: null, jobObjectName: null, targetStarted: true }, async () => {});
    const { service, signal } = await setup({ inspect: async () => { throw new AggregateError([new Error("query failed"), original]); } });
    await expect(service.discover({ provider: "codex" }, signal)).rejects.toMatchObject({ code: "cleanup_unknown", cause: expect.any(AggregateError) });
  });

  it("preserves a native SDK cleanup failure even when supervisor termination succeeds", async () => {
    const original = Object.assign(new Error("SDK transport did not confirm close"), { code: "cleanup_unknown" });
    const { service, signal } = await setup({ inspect: async () => { throw original; } });
    await expect(service.discover({ provider: "copilot" }, signal)).rejects.toMatchObject({ code: "cleanup_unknown", cause: original });
  });

  it("rejects oversized or malformed native catalogs", async () => {
    for (const native of [
      { ...observation(), models: Array.from({ length: 501 }, (_, index) => ({ id: String(index), efforts: null })) },
      { ...observation(), models: [{ id: "x".repeat(257), efforts: null }] },
      { ...observation(), models: [{ id: "a", efforts: ["low"], defaultEffort: "high" }] },
      { ...observation(), models: [{ id: "a", efforts: null }, { id: "a", efforts: null }] },
    ]) {
      const { service, signal } = await setup({ inspect: async () => native });
      await expect(service.discover({ provider: "codex" }, signal)).rejects.toMatchObject({ code: expect.stringMatching(/limit_exceeded|capability_error/) });
    }
  });

  it("rejects queries after close", async () => {
    const { service, signal } = await setup(); service.close();
    await expect(service.discover({ provider: "codex" }, signal)).rejects.toMatchObject({ code: "cancelled" });
  });

  it("keeps every response below the byte limit without dropping entries between pages", async () => {
    const catalog = Array.from({ length: 101 }, (_, index) => ({ id: `model-${index}`, label: "文".repeat(300), efforts: ["low"] }));
    const { service, signal } = await setup({ inspect: async () => ({ model: "model-0", models: catalog }) });
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await service.discover({ provider: "codex", ...(cursor === undefined ? {} : { cursor }) }, signal);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65_536);
      ids.push(...result.models.map(model => model.id));
      cursor = result.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(ids).toEqual(catalog.map(model => model.id));
  });

  it("does not let a returned page mutate retained snapshot defaults or entries", async () => {
    const { service, signal } = await setup();
    const first = await service.discover({ provider: "codex", limit: 1 }, signal);
    first.defaults.model.value = "altered";
    const second = await service.discover({ provider: "codex", limit: 1, cursor: first.nextCursor! }, signal);
    expect(second.defaults.model.value).toBe("a");
  });

  it("returns an empty visible catalog when the only native model is hidden", async () => {
    const { service, signal } = await setup({ inspect: async () => ({ model: "hidden", models: [{ id: "hidden", hidden: true, efforts: null }] }) });
    expect(await service.discover({ provider: "codex" }, signal)).toMatchObject({ models: [], nextCursor: null, selectionError: null });
  });

  it("does not accept ambiguous aliases or an unobserved configured model", async () => {
    const { service, signal } = await setup({ inspect: async () => ({ model: "alias", models: [
      { id: "first", aliases: ["alias"], efforts: ["low"] }, { id: "second", aliases: ["alias"], efforts: ["high"] },
    ] }) });
    expect((await service.discover({ provider: "claude" }, signal)).selectionError?.code).toBe("unsupported_selection");
    expect((await service.discover({ provider: "claude", model: "absent" }, signal)).selectionError?.code).toBe("unsupported_selection");
  });

  it("retains the finite native deadline while waiting for the verifier", async () => {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const { service, signal } = await setup({ inspect: async (_native, operation) => {
      entered();
      return new Promise((_resolve, reject) => operation.signal.addEventListener("abort", () => reject(operation.signal.reason), { once: true }));
    } });
    vi.useFakeTimers();
    const pending = service.discover({ provider: "codex" }, signal);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await ready;
    await vi.advanceTimersByTimeAsync(8_001);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(17_000);
    await assertion;
  });
});

describe("model input", () => {
  it.each([{}, null, { provider: "other" }, { provider: ["codex"] }, { provider: "codex", cwd: "relative" }, { provider: "codex", cwd: null },
    { provider: "codex", model: "" }, { provider: "codex", model: "x".repeat(257) }, { provider: "codex", includeHidden: null },
    { provider: "codex", limit: 0 }, { provider: "codex", limit: 101 }, { provider: "codex", limit: 1.5 },
    { provider: "codex", cursor: null }, { provider: "codex", cursor: "" }, { provider: "codex", unexpected: true },
  ])("rejects malformed query %j", input => expect(() => parseWorkerModelInput(input)).toThrow(expect.objectContaining({ code: "invalid_input" })));
});
