import path from "node:path";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { createOperation, type Operation } from "../../../src/api/operation.js";
import { parseToolPathTelemetry } from "../../../src/api/worker-tool-paths.js";
import { ToolSelectionError, toolCommand, type ResolvedToolLaunch } from "../../../src/platform/tool-executables.js";
import { ToolSelectionManager, type ToolSelectionProbe, type ActiveToolSelection } from "../../../src/commands/worker/tool-selection.js";
import { removeFixtureRoot } from "../../helpers/tool-fixture-cleanup.js";

const now = "2026-11-12T00:00:00.000Z", operations: Operation[] = [];
const op = () => { const result = createOperation({ limits: { totalMs: 5000 } }); operations.push(result); return result; };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const targets = (label: string, revision = "1") => ({ source: "cloud" as const, revision, choices: { codex: { kind: "path" as const, path: path.resolve(`/tools/${label}`) }, copilot: { kind: "auto" as const }, herdr: { kind: "auto" as const } } });
const launch = (label: string): ResolvedToolLaunch => ({ schemaVersion: 1, tool: "codex", context: "web", source: "explicit", entryPath: path.resolve(`/tools/${label}`), canonicalEntryPath: path.resolve(`/tools/${label}`), executablePath: path.resolve(`/tools/${label}`), interpreterPath: null, command: { file: path.resolve(`/tools/${label}`), prefixArgs: [] }, artifacts: [], selectionKey: label.charCodeAt(0).toString(16).padStart(64, "0") });
const create = (options: { probe?: Partial<ToolSelectionProbe>; readActiveSelections?: () => readonly ActiveToolSelection[]; verify?: (value: ResolvedToolLaunch) => Promise<void>; resolve?: (input: { choice: { kind: "path"; path: string } | { kind: "auto" } }) => Promise<ResolvedToolLaunch>; admitHerdr?: (value: ResolvedToolLaunch, operation: Operation) => Promise<{ state: "applied"; version: string; checkedAt: string } | { state: "pending"; reason: "active_instance" | "cleanup_unconfirmed" }> } = {}) => {
  const checked: string[] = [];
  const manager = new ToolSelectionManager({ environment: {}, cwd: path.resolve("/work"), now: () => now, readActiveSelections: options.readActiveSelections ?? (() => []),
    resolve: async input => options.resolve ? options.resolve(input) : ({ ...launch(input.choice.kind === "path" ? path.basename(input.choice.path) : "A"), tool: input.tool, context: input.context, source: input.choice.kind === "path" ? "explicit" : "path" }),
    ...(options.admitHerdr ? { admitHerdr: options.admitHerdr } : {}), verify: options.verify ?? (async () => {}), probe: { check: async value => { checked.push(value.entryPath); return { version: "1.2.3", checkedAt: now }; }, close: async () => {}, ...options.probe } });
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
  manager.setTargets(targets("B", "2")); const next = manager.prepare("codex", "web", op()); release.resolve(); await old; await next;
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
test("preparation reconciles original cleanup before sampling the fresh probe generation", async () => {
  let generation = 0, pending = true;
  const operation = op(), reconcile = vi.fn(async (_launch: ResolvedToolLaunch, parent: Operation) => { expect(parent).toBe(operation); pending = false; generation++; });
  const { manager, checked } = create({ probe: { reconcile, cacheToken: () => generation,
    assertAvailable: value => { if (pending) throw new ToolSelectionError(value.tool, value.context, "probe", "cleanup_unknown"); },
  } });
  manager.setTargets(targets("A"));
  const selected = await manager.selectForNewExecution("codex", "web", operation);
  expect(reconcile).toHaveBeenCalledOnce(); expect(checked).toHaveLength(1);
  expect(manager.currentSelection("codex", "web")?.selectionKey).toBe(selected.selectionKey);
  await manager.prepare("codex", "web", operation); expect(reconcile).toHaveBeenCalledOnce(); expect(checked).toHaveLength(1);
});
test("preparation bounds cleanup reconciliation and never probes after its deadline", async () => {
  vi.useFakeTimers();
  const entered = deferred(), release = deferred(), check = vi.fn(async () => ({ version: "1.2.3" }));
  const { manager } = create({ probe: { reconcile: async () => { entered.resolve(); await release.promise; }, check } });
  const short = createOperation({ limits: { totalMs: 100 } }); operations.push(short);
  manager.setTargets(targets("A"));
  const pending = manager.prepare("codex", "web", short), failed = expect(pending).rejects.toMatchObject({ code: "probe_timeout" });
  try {
    await entered.promise; await vi.advanceTimersByTimeAsync(100); await failed;
    expect(check).not.toHaveBeenCalled(); expect(manager.currentSelection("codex", "web")).toBeUndefined();
    release.resolve(); await vi.advanceTimersByTimeAsync(0); expect(check).not.toHaveBeenCalled();
  } finally { release.resolve(); await manager.close(op()); }
});
test("selection checks the target again after identity verification", async () => {
  const entered = deferred(), release = deferred(); let calls = 0; const { manager } = create({ verify: async value => { if (value.entryPath.endsWith("A") && ++calls === 2) { entered.resolve(); await release.promise; } } });
  manager.setTargets(targets("A")); const selected = manager.selectForNewExecution("codex", "web", op()); await entered.promise;
  manager.setTargets(targets("B", "2")); release.resolve(); await expect(selected).resolves.toMatchObject({ entryPath: path.resolve("/tools/B") });
});
test.each(["prepare", "final selection"])("refreshes a changed cached identity during %s in the same call", async phase => {
  let current = "A", verifications = 0;
  const events: string[] = [];
  const recipe = (label: string) => ({ ...launch(label), entryPath: path.resolve("/tools/stable") });
  const { manager } = create({
    resolve: async () => recipe(current),
    verify: async value => {
      verifications++;
      if (value.selectionKey !== recipe(current).selectionKey) throw new ToolSelectionError(value.tool, value.context, "verify", "tool_identity_changed");
      if (phase === "final selection" && verifications === 4) { current = "B"; throw new ToolSelectionError(value.tool, value.context, "verify", "tool_identity_changed"); }
    },
    probe: { reconcile: async value => { events.push(`reconcile ${value.selectionKey}`); }, check: async value => { events.push(`check ${value.selectionKey}`); return { version: value.selectionKey === recipe("A").selectionKey ? "1.0.0" : "2.0.0" }; } },
  });
  manager.setTargets(targets("stable"));
  const frozen = await manager.selectForNewExecution("codex", "web", op());
  if (phase === "prepare") current = "B";
  const selected = await manager.selectForNewExecution("codex", "web", op());
  expect(selected.selectionKey).toBe(recipe("B").selectionKey);
  expect(events).toEqual([`reconcile ${recipe("A").selectionKey}`, `check ${recipe("A").selectionKey}`, `reconcile ${recipe("A").selectionKey}`, `reconcile ${recipe("B").selectionKey}`, `check ${recipe("B").selectionKey}`]);
  expect(manager.observationFor(frozen)).toBeUndefined();
  expect(entry(manager).actual).toMatchObject({ version: "2.0.0" });
  await expect(manager.verifyFrozen(frozen, op())).rejects.toMatchObject({ code: "tool_identity_changed" });
});

test.each(["failed first probe", "invalidated cache", "target change"])("retains the original cleanup responsibility after %s", async scenario => {
  let current = "A", blocked = false;
  const events: string[] = [];
  const { manager } = create({ resolve: async input => ({ ...launch(current), entryPath: input.choice.kind === "path" ? input.choice.path : launch(current).entryPath }), probe: {
    reconcile: async value => { events.push(`reconcile ${path.basename(value.canonicalEntryPath)}`); if (blocked && value.selectionKey === launch("A").selectionKey) throw new ToolSelectionError(value.tool, value.context, "probe", "cleanup_unknown"); },
    check: async value => { events.push(`check ${path.basename(value.canonicalEntryPath)}`); if (scenario === "failed first probe" && value.selectionKey === launch("A").selectionKey) throw new ToolSelectionError(value.tool, value.context, "probe", "cleanup_unknown"); return { version: "1.0.0" }; },
    assertAvailable: value => { if (scenario === "invalidated cache" && blocked && value.selectionKey === launch("A").selectionKey) throw new ToolSelectionError(value.tool, value.context, "probe", "cleanup_unknown"); },
  } });
  manager.setTargets(targets("A"));
  if (scenario === "failed first probe") await expect(manager.prepare("codex", "web", op())).rejects.toMatchObject({ code: "cleanup_unknown" });
  else await manager.prepare("codex", "web", op());
  blocked = true; current = "B";
  if (scenario === "target change") manager.setTargets(targets("B", "2"));
  await expect(manager.selectForNewExecution("codex", "web", op())).rejects.toMatchObject({ code: "cleanup_unknown" });
  expect(events.filter(event => event === "check B")).toHaveLength(0);
  blocked = false;
  await expect(manager.selectForNewExecution("codex", "web", op())).resolves.toMatchObject({ selectionKey: launch("B").selectionKey });
  expect(events.slice(-3)).toEqual(["reconcile A", "reconcile B", "check B"]);
});

test("a changed target waits for the in-flight probe before reconciling its original recipe", async () => {
  const entered = deferred(), release = deferred(), events: string[] = [];
  const { manager } = create({ probe: {
    reconcile: async value => { events.push(`reconcile ${path.basename(value.entryPath)}`); },
    check: async value => { const name = path.basename(value.entryPath); events.push(`check ${name}`); if (name === "A") { entered.resolve(); await release.promise; } return { version: "1.0.0" }; },
  } });
  manager.setTargets(targets("A")); const first = manager.prepare("codex", "web", op()); await entered.promise;
  manager.setTargets(targets("B", "2")); const next = manager.prepare("codex", "web", op());
  await Promise.resolve(); expect(events).toEqual(["reconcile A", "check A"]);
  release.resolve(); await first; await next;
  expect(events).toEqual(["reconcile A", "check A", "reconcile A", "reconcile B", "check B"]);
});

for (const mode of ["in-place", "symlink"] as const) test.skipIf(mode === "symlink" && process.platform === "win32")(`refreshes a real ${mode} installation in one selection`, async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/tool-selection-tests");
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(path.join(scratch, "upgrade-"));
  try {
    const first = path.join(root, "first.js"), second = path.join(root, "second.js"), entryPath = mode === "symlink" ? path.join(root, "tool.js") : first;
    await writeFile(first, "#!/usr/bin/env node\nconsole.log('1.0.0')\n");
    await writeFile(second, "#!/usr/bin/env node\nconsole.log('2.0.0')\n");
    if (mode === "symlink") await symlink(first, entryPath, "file");
    const checks: string[] = [], manager = new ToolSelectionManager({ environment: process.env, cwd: root, workerNode: process.execPath, now: () => now, readActiveSelections: () => [], probe: {
      check: async value => { const command = toolCommand(value, []); const result = await promisify(execFile)(command.file, command.args, { cwd: root, timeout: 5000 }); checks.push(result.stdout.trim()); return { version: result.stdout.trim(), checkedAt: now }; }, close: async () => {},
    } });
    manager.setTargets({ source: "cloud", revision: "1", choices: { codex: { kind: "path", path: entryPath }, copilot: { kind: "auto" }, herdr: { kind: "auto" } } });
    const old = await manager.selectForNewExecution("codex", "web", op());
    if (mode === "symlink") { await rm(entryPath); await symlink(second, entryPath, "file"); await rm(first); }
    else await writeFile(first, "#!/usr/bin/env node\nconsole.log('2.0.0')\n");
    const selected = await manager.selectForNewExecution("codex", "web", op());
    expect(selected.entryPath).toBe(entryPath); expect(selected.selectionKey).not.toBe(old.selectionKey);
    expect(checks).toEqual(["1.0.0", "2.0.0"]); expect(entry(manager).actual?.version).toBe("2.0.0");
    await expect(manager.verifyFrozen(old, op())).rejects.toMatchObject({ code: "tool_identity_changed" });
    await manager.close(op());
  } finally { await removeFixtureRoot(root); }
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


test("Herdr candidates wait for the original shared instance and publish its handshake version", async () => {
  let busy = true;
  const { manager } = create({ admitHerdr: async () => busy ? { state: "pending", reason: "active_instance" } : { state: "applied", version: "0.9.5", checkedAt: now } });
  await manager.prepare("herdr", "herdr", op());
  const observed = () => manager.snapshot().entries.find(value => value.tool === "herdr")!;
  expect(observed()).toMatchObject({ state: "pending", reason: "active_instance", actual: null, candidate: { version: "1.2.3" } });
  await expect(manager.selectForNewExecution("herdr", "herdr", op())).rejects.toThrow("active_instance");
  busy = false;
  const chosen = await manager.selectForNewExecution("herdr", "herdr", op());
  expect(observed()).toMatchObject({ state: "applied", reason: null, candidate: null, actual: { version: "0.9.5" } });
  expect(manager.observationFor(chosen)).toEqual({ version: "0.9.5", checkedAt: now });
  expect(parseToolPathTelemetry(manager.snapshot())).toEqual(manager.snapshot());
});

test.each(["active_instance", "cleanup_unconfirmed"] as const)("a refreshed Herdr candidate retains the old instance while admission reports %s", async reason => {
  let current = "A", blocked = true;
  const events: string[] = [];
  const recipe = (label: string): ResolvedToolLaunch => ({ ...launch(label), tool: "herdr", context: "herdr", source: "path", entryPath: path.resolve("/tools/stable") });
  const { manager } = create({
    resolve: async () => recipe(current),
    verify: async value => { if (value.selectionKey !== recipe(current).selectionKey) throw new ToolSelectionError(value.tool, value.context, "verify", "tool_identity_changed"); },
    probe: {
      reconcile: async value => { events.push(`reconcile ${value.selectionKey}`); return value.selectionKey; },
      admit: (value, receipt) => { expect(receipt).toBe(value.selectionKey); events.push(`admit ${value.selectionKey}`); },
      check: async value => { events.push(`check ${value.selectionKey}`); return { version: `probe-${current}`, checkedAt: now }; },
    },
    admitHerdr: async value => { events.push(`instance ${value.selectionKey}`); return current === "B" && blocked ? { state: "pending", reason } : { state: "applied", version: `instance-${current}`, checkedAt: now }; },
    readActiveSelections: () => [{ tool: "herdr", context: "herdr", launch: recipe("A"), version: "instance-A", checkedAt: now, executionCount: 1, instanceCount: 1, unconfirmedCount: 0 }],
  });
  const original = await manager.selectForNewExecution("herdr", "herdr", op());
  events.length = 0; current = "B";
  await expect(manager.selectForNewExecution("herdr", "herdr", op())).rejects.toThrow(reason);
  expect(events).toEqual([`reconcile ${original.selectionKey}`, `reconcile ${recipe("B").selectionKey}`, `admit ${recipe("B").selectionKey}`, `check ${recipe("B").selectionKey}`, `instance ${recipe("B").selectionKey}`]);
  const observed = manager.snapshot().entries.find(value => value.tool === "herdr")!;
  expect(observed).toMatchObject({ state: "pending", reason, actual: { version: "instance-A" }, candidate: { version: "probe-B" }, activeSelectionCount: 1 });
  expect(observed.activeSelections[0]?.actual.selectionKey).toBe(original.selectionKey);
  expect(manager.currentSelection("herdr", "herdr")).toBeUndefined();
  await expect(manager.verifyFrozen(original, op())).rejects.toMatchObject({ code: "tool_identity_changed" });
  blocked = false;
  const selected = await manager.selectForNewExecution("herdr", "herdr", op());
  expect(selected.selectionKey).toBe(recipe("B").selectionKey);
  expect(manager.observationFor(selected)).toEqual({ version: "instance-B", checkedAt: now });
  expect(parseToolPathTelemetry(manager.snapshot())).toEqual(manager.snapshot());
});
