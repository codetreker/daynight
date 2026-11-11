import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createOperation, type Operation } from "../../../src/api/operation.js";
import { parseToolPathTelemetry } from "../../../src/api/worker-tool-paths.js";
import { ToolSelectionError, type ResolvedToolLaunch } from "../../../src/platform/tool-executables.js";
import { ToolSelectionManager, type ToolSelectionProbe, type ActiveToolSelection } from "../../../src/commands/worker/tool-selection.js";

const now = "2026-11-12T00:00:00.000Z", operations: Operation[] = [];
const op = () => { const result = createOperation({ limits: { totalMs: 5000 } }); operations.push(result); return result; };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const targets = (label: string, revision = "1") => ({ source: "cloud" as const, revision, choices: { codex: { kind: "path" as const, path: path.resolve(`/tools/${label}`) }, copilot: { kind: "auto" as const }, herdr: { kind: "auto" as const } } });
const launch = (label: string): ResolvedToolLaunch => ({ schemaVersion: 1, tool: "codex", context: "web", source: "explicit", entryPath: path.resolve(`/tools/${label}`), canonicalEntryPath: path.resolve(`/tools/${label}`), executablePath: path.resolve(`/tools/${label}`), interpreterPath: null, command: { file: path.resolve(`/tools/${label}`), prefixArgs: [] }, artifacts: [], selectionKey: label.charCodeAt(0).toString(16).padStart(64, "0") });
const create = (options: { probe?: Partial<ToolSelectionProbe>; readActiveSelections?: () => readonly ActiveToolSelection[]; verify?: (value: ResolvedToolLaunch) => Promise<void> } = {}) => {
  const checked: string[] = [];
  const manager = new ToolSelectionManager({ environment: {}, cwd: path.resolve("/work"), now: () => now, readActiveSelections: options.readActiveSelections ?? (() => []),
    resolve: async input => ({ ...launch(input.choice.kind === "path" ? path.basename(input.choice.path) : "A"), tool: input.tool, context: input.context, source: input.choice.kind === "path" ? "explicit" : "path" }),
    verify: options.verify ?? (async () => {}), probe: { check: async value => { checked.push(value.entryPath); return { version: "1.2.3", checkedAt: now }; }, close: async () => {}, ...options.probe } });
  return { manager, checked };
};
const entry = (manager: ToolSelectionManager) => manager.snapshot().entries.find(value => value.tool === "codex" && value.context === "web")!;
afterEach(() => { operations.splice(0).forEach(value => value.dispose()); vi.useRealTimers(); });

test("target publication does not probe and unchanged choices retain verified results at a new revision", async () => {
  const { manager, checked } = create(); manager.setTargets(targets("A"));
  expect(entry(manager)).toMatchObject({ state: "not_checked", actual: null }); expect(checked).toEqual([]);
  await manager.prepare("codex", "web", op()); manager.setTargets(targets("A", "2")); await manager.prepare("codex", "web", op());
  expect(checked).toHaveLength(1); expect(entry(manager)).toMatchObject({ state: "applied", targetRevision: "2" });
  expect(parseToolPathTelemetry(manager.snapshot())).toEqual(manager.snapshot());
});
test("an old candidate cannot overwrite a newer successful target", async () => {
  const entered = deferred(), release = deferred(); const { manager } = create({ probe: { check: async value => { if (value.entryPath.endsWith("A")) { entered.resolve(); await release.promise; } return { version: value.entryPath.endsWith("A") ? "1.0.0" : "2.0.0" }; } } });
  manager.setTargets(targets("A")); const old = manager.prepare("codex", "web", op()); await entered.promise;
  manager.setTargets(targets("B", "2")); await manager.prepare("codex", "web", op()); release.resolve(); await old;
  expect(entry(manager)).toMatchObject({ state: "applied", targetRevision: "2", actual: { entryPath: path.resolve("/tools/B"), version: "2.0.0" } });
});
test("failed new targets retain old facts but do not prevent frozen verification or another tool", async () => {
  const { manager } = create({ probe: { check: async value => { if (value.entryPath.endsWith("B")) throw new ToolSelectionError(value.tool, value.context, "probe", "incompatible_runtime"); return { version: "1.0.0" }; } } });
  manager.setTargets(targets("A")); const frozen = await manager.selectForNewExecution("codex", "web", op()); manager.setTargets(targets("B", "2"));
  await expect(manager.selectForNewExecution("codex", "web", op())).rejects.toMatchObject({ code: "incompatible_runtime" });
  expect(manager.currentSelection("codex", "web")).toBeUndefined(); await manager.verifyFrozen(frozen, op());
  await manager.selectForNewExecution("copilot", "web", op()); expect(entry(manager)).toMatchObject({ state: "error", actual: { entryPath: path.resolve("/tools/A") } });
});
test("cleanup generation invalidates prior success even when closure later succeeds", async () => {
  let generation = 0, pending = false; const { manager, checked } = create({ probe: { cacheToken: () => generation, assertAvailable: value => { if (pending) throw new ToolSelectionError(value.tool, value.context, "probe", "cleanup_unknown"); } } });
  manager.setTargets(targets("A")); await manager.selectForNewExecution("codex", "web", op()); generation++; pending = true;
  expect(manager.currentSelection("codex", "web")).toBeUndefined(); expect(entry(manager)).toMatchObject({ state: "pending", reason: "cleanup_unconfirmed" }); expect(manager.observationFor(launch("A"))).toBeUndefined(); await expect(manager.selectForNewExecution("codex", "web", op())).rejects.toMatchObject({ code: "cleanup_unknown" });
  expect(checked).toHaveLength(1); pending = false; await manager.selectForNewExecution("codex", "web", op()); expect(checked).toHaveLength(2);
});
test("selection checks the target again after identity verification", async () => {
  const entered = deferred(), release = deferred(); let calls = 0; const { manager } = create({ verify: async value => { if (value.entryPath.endsWith("A") && ++calls === 2) { entered.resolve(); await release.promise; } } });
  manager.setTargets(targets("A")); const selected = manager.selectForNewExecution("codex", "web", op()); await entered.promise;
  manager.setTargets(targets("B", "2")); release.resolve(); await expect(selected).resolves.toMatchObject({ entryPath: path.resolve("/tools/B") });
});
test("close joins old target work and closes the shared owner without admitting more tools", async () => {
  const entered = deferred(), release = deferred(), closing = deferred(); let finished = false;
  const { manager } = create({ probe: { check: async () => { entered.resolve(); await release.promise; return { version: "1.0.0" }; }, close: async () => { closing.resolve(); } } });
  manager.setTargets(targets("A")); const pending = manager.prepare("codex", "web", op()); await entered.promise; manager.setTargets(targets("B", "2"));
  const closed = manager.close(op()).then(() => { finished = true; }); await closing.promise; expect(finished).toBe(false); release.resolve(); await pending; await closed;
  await expect(manager.selectForNewExecution("codex", "web", op())).rejects.toMatchObject({ code: "cancelled" });
});
test("close respects its deadline and subsequent callers join the same unfinished probe closure", async () => {
  vi.useFakeTimers();
  const entered = deferred(), release = deferred(), close = vi.fn(async () => { entered.resolve(); await release.promise; });
  const { manager } = create({ probe: { close } });
  const short = createOperation({ limits: { totalMs: 100 } }); operations.push(short);
  const pending = manager.close(short), failed = expect(pending).rejects.toThrow("cleanup remains unconfirmed");
  try {
    await entered.promise; await vi.advanceTimersByTimeAsync(100); await failed;
    const recovered = manager.close(op());
    await Promise.resolve(); expect(close).toHaveBeenCalledOnce();
    release.resolve(); await recovered;
  } finally { release.resolve(); }
});
test("Herdr capabilities stay unverified and explicit targets fail before any probe", async () => {
  const { manager, checked } = create(); await manager.prepare("copilot", "herdr", op());
  expect(manager.snapshot().entries.find(value => value.tool === "copilot" && value.context === "herdr")?.state).toBe("not_checked");
  manager.setTargets(targets("A")); await expect(manager.prepare("codex", "herdr", op())).rejects.toMatchObject({ code: "incompatible_runtime" }); expect(checked).toEqual([]);
});
test("active inventory groups original identities, bounds complete groups and labels missing history independently", async () => {
  const records: ActiveToolSelection[] = Array.from({ length: 10 }, (_, index) => ({ tool: "codex", context: "web", launch: launch(String.fromCharCode(65 + index)), version: "1.0.0", checkedAt: now, executionCount: 1, instanceCount: 0, unconfirmedCount: 0 }));
  records.push({ ...records[0]!, executionCount: 2 }); records.push({ ...records[0]!, launch: null, version: null, checkedAt: null });
  const { manager } = create({ readActiveSelections: () => records }); manager.setTargets(targets("A")); await manager.prepare("codex", "web", op());
  expect(entry(manager)).toMatchObject({ state: "applied", activeSelectionCount: null, activeSelectionsComplete: false, activeObservationError: "legacy_tool_identity_missing" });
  expect(entry(manager).activeSelections).toHaveLength(8); expect(entry(manager).activeSelections[0]?.executionCount).toBe(3);
  expect(parseToolPathTelemetry(manager.snapshot())).toEqual(manager.snapshot());
});

test("freezes observation only for the currently inspected recipe and never reconstructs old facts", async () => {
  const { manager } = create(); manager.setTargets(targets("A"));
  const first = await manager.selectForNewExecution("codex", "web", op());
  expect(manager.observationFor(first)).toEqual({ version: "1.2.3", checkedAt: now });
  manager.setTargets(targets("B", "2")); expect(manager.observationFor(first)).toBeUndefined();
  await manager.prepare("codex", "web", op()); expect(manager.observationFor(first)).toBeUndefined();
});

test("an incomplete cloud target revokes new launches while preserving frozen verification and prior facts", async () => {
  const { manager } = create(); manager.setTargets(targets("A"));
  const frozen = await manager.selectForNewExecution("codex", "web", op()); manager.suspendTargets();
  expect(manager.currentSelection("codex", "web")).toBeUndefined();
  expect(entry(manager)).toMatchObject({ state: "pending", reason: "configuration_unavailable", actual: { entryPath: path.resolve("/tools/A") } });
  expect(parseToolPathTelemetry(manager.snapshot())).toEqual(manager.snapshot());
  await expect(manager.selectForNewExecution("codex", "web", op())).rejects.toThrow("configuration is unavailable");
  await manager.verifyFrozen(frozen, op()); manager.setTargets(targets("A", "2"));
  expect((await manager.selectForNewExecution("codex", "web", op())).selectionKey).toBe(frozen.selectionKey);
});
