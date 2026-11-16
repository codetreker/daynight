import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createWorkerToolSelectionRuntime } from "../../../src/commands/worker/tool-selection-runtime.js";

test("configured checks settle all contexts, cache success and never start a Herdr instance", async () => {
  const scratch = path.resolve("../../.tmp/tool-selection-runtime-tests"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "configured-")), codex = path.join(root, "codex.cjs"), herdr = path.join(root, "herdr.cjs");
  await writeFile(codex, "console.log(process.argv.includes('--version') ? 'codex-cli 1.0.0' : 'app-server --stdio');\n");
  await writeFile(herdr, "console.log('herdr 0.9.9');\n");
  const admitHerdr = vi.fn(async () => ({ state: "applied" as const, version: "0.9.9", checkedAt: new Date().toISOString() }));
  const runtime = createWorkerToolSelectionRuntime({ workerDirectory: root, cwd: root, environment: {}, readActiveSelections: () => [], admitHerdr,
    localToolPaths: { codex: { kind: "path", path: codex }, copilot: { kind: "path", path: path.join(root, "missing-copilot") }, herdr: { kind: "path", path: herdr } } });
  const check = vi.spyOn(runtime.manager, "check"), signal = new AbortController().signal;
  const realNow = Date.now; let elapsed = 0; const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + elapsed);
  try {
    const first = runtime.checkConfiguredTools(signal);
    expect(await runtime.checkConfiguredTools(signal)).toBe(false);
    expect(await first).toBe(true);
    const entries = runtime.manager.snapshot().entries;
    expect(entries.filter(entry => entry.tool !== "copilot").map(entry => [entry.tool, entry.context, entry.state, entry.actual?.version])).toEqual([
      ["codex", "web", "applied", "1.0.0"], ["codex", "herdr", "applied", "1.0.0"], ["herdr", "herdr", "applied", "0.9.9"],
    ]);
    expect(entries.filter(entry => entry.tool === "copilot")).toEqual([expect.objectContaining({ state: "error", error: { code: "not_found", occurredAt: expect.any(String) } }), expect.objectContaining({ state: "error", error: { code: "not_found", occurredAt: expect.any(String) } })]);
    expect(check).toHaveBeenCalledTimes(5); expect(admitHerdr).not.toHaveBeenCalled();
    expect(await runtime.checkConfiguredTools(signal)).toBe(false);
    elapsed += 60_001;
    expect(await runtime.checkConfiguredTools(signal)).toBe(true);
    expect(check.mock.calls.slice(5).map(([tool]) => tool)).toEqual(["copilot", "copilot"]);
    expect(admitHerdr).not.toHaveBeenCalled();

    runtime.setTargets({ source: "cloud", revision: "2", choices: { codex: { kind: "auto" }, copilot: { kind: "path", path: path.join(root, "missing-copilot") }, herdr: { kind: "path", path: herdr } } });
    await runtime.checkConfiguredTools(signal);
    expect(runtime.manager.snapshot().entries.filter(entry => entry.tool === "codex")).toEqual([expect.objectContaining({ target: { kind: "auto" }, state: "error" }), expect.objectContaining({ target: { kind: "auto" }, state: "error" })]);
    runtime.setTargets({ source: "cloud", revision: "3", choices: { codex: { kind: "path", path: codex }, copilot: { kind: "path", path: path.join(root, "missing-copilot") }, herdr: { kind: "path", path: herdr } } });
    await runtime.checkConfiguredTools(signal);
    expect(runtime.manager.snapshot().entries.filter(entry => entry.tool === "codex").every(entry => entry.state === "applied")).toBe(true);
    runtime.setTargets(null);
    expect(await runtime.checkConfiguredTools(signal)).toBe(false);
  } finally { clock.mockRestore(); check.mockRestore(); try { await runtime.close(); } finally { await rm(root, { recursive: true, force: true }); } }
}, 30_000);

test("target changes cancel old configured checks and shutdown drains pending checks", async () => {
  const scratch = path.resolve("../../.tmp/tool-selection-runtime-tests"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "configured-cancel-"));
  const runtime = createWorkerToolSelectionRuntime({ workerDirectory: root, cwd: root, environment: {}, readActiveSelections: () => [],
    localToolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" }, herdr: { kind: "auto" } } });
  const aborted: string[] = [];
  const check = vi.spyOn(runtime.manager, "check").mockImplementation((tool, context, operation) => new Promise(resolve => {
    operation.signal.addEventListener("abort", () => { aborted.push(`${tool}/${context}`); resolve(); }, { once: true });
  }));
  try {
    const first = runtime.checkConfiguredTools(new AbortController().signal);
    expect(check).toHaveBeenCalledTimes(5);
    runtime.setTargets({ source: "cloud", revision: "1", choices: { codex: { kind: "path", path: path.join(root, "new.cjs") }, copilot: { kind: "auto" }, herdr: { kind: "auto" } } });
    expect(aborted).toEqual(["codex/web", "codex/herdr"]);
    await runtime.close(); await first;
    expect(aborted).toHaveLength(5);
    expect(await runtime.checkConfiguredTools(new AbortController().signal)).toBe(false);
  } finally { check.mockRestore(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("runtime freezes inspected facts and host snapshots do no process work", async () => {
  const scratch = path.resolve("../../.tmp/tool-selection-runtime-tests"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "run-")), receipt = path.join(root, "receipt");
  const entry = path.join(root, "codex.mjs");
  await writeFile(entry, `#!/usr/bin/env node\nimport{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(receipt)},JSON.stringify(process.argv.slice(2))+'\\n');console.log(process.argv.includes('--version')?'codex-cli 1.0.0':'app-server --stdio');\n`);
  await chmod(entry, 0o755);
  const runtime = createWorkerToolSelectionRuntime({ workerDirectory: root, cwd: root, environment: {}, readActiveSelections: () => [],
    localToolPaths: { codex: { kind: "path", path: entry }, copilot: { kind: "path", path: path.join(root, "missing-copilot") }, herdr: { kind: "auto" } } });
  const operation = createOperation({ limits: { totalMs: 20_000 } });
  try {
    await runtime.prepareWebCandidates(operation.signal, false);
    const configuration = await runtime.freezeConfiguration({ agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 }, operation.signal);
    expect(configuration.toolObservation).toMatchObject({ version: "1.0.0" }); expect(configuration.toolLaunch?.entryPath).toBe(entry);
    const before = await readFile(receipt, "utf8");
    expect(await runtime.hostInspector.check(configuration.toolLaunch!, operation)).toEqual(configuration.toolObservation);
    runtime.manager.snapshot(); expect(await readFile(receipt, "utf8")).toBe(before);
    expect(before.trim().split("\n")).toHaveLength(2);
    await rm(entry);
    await expect(runtime.manager.prepare("codex", "web", operation)).rejects.toMatchObject({ code: "not_found" });
    expect(runtime.manager.currentSelection("codex", "web")).toBeUndefined();
    await expect(runtime.hostInspector.check(configuration.toolLaunch!, operation)).rejects.toThrow("no current inspection proof");
    expect(await runtime.freezeConfiguration(configuration, operation.signal)).toBe(configuration);
  } finally { try { await runtime.close(); } finally { operation.dispose(); await rm(root, { recursive: true, force: true }); } }
});

test("background preparation follows Copilot demand on each refresh", async () => {
  const scratch = path.resolve("../../.tmp/tool-selection-runtime-tests"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "demand-"));
  const runtime = createWorkerToolSelectionRuntime({ workerDirectory: root, cwd: root, environment: {}, readActiveSelections: () => [],
    localToolPaths: { codex: { kind: "path", path: path.join(root, "missing-codex") }, copilot: { kind: "path", path: path.join(root, "missing-copilot") }, herdr: { kind: "auto" } } });
  const operation = createOperation({ limits: { totalMs: 20_000 } });
  const prepare = vi.spyOn(runtime.manager, "prepare");
  let now = Date.now(); const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const copilot = () => runtime.manager.snapshot().entries.find(entry => entry.tool === "copilot" && entry.context === "web")!;
  try {
    await runtime.prepareWebCandidates(operation.signal, false);
    now += 60_001;
    await runtime.prepareWebCandidates(operation.signal, false);
    expect(prepare.mock.calls.map(([tool]) => tool)).toEqual(["codex", "codex"]);
    expect(copilot()).toMatchObject({ state: "not_checked", actual: null, error: null });

    // Demand changes bypass the preceding refresh window in both directions.
    await runtime.prepareWebCandidates(operation.signal, true);
    expect(prepare.mock.calls.map(([tool]) => tool)).toEqual(["codex", "codex", "codex", "copilot"]);
    expect(copilot()).toMatchObject({ state: "error", error: { code: "not_found" } });
    await runtime.prepareWebCandidates(operation.signal, false);
    now += 60_001;
    await runtime.prepareWebCandidates(operation.signal, false);
    expect(prepare.mock.calls.map(([tool]) => tool)).toEqual(["codex", "codex", "codex", "copilot", "codex", "codex"]);
  } finally { clock.mockRestore(); prepare.mockRestore(); try { await runtime.close(); } finally { operation.dispose(); await rm(root, { recursive: true, force: true }); } }
});

test("demand changes during a refresh take effect after the current preparation settles", async () => {
  const scratch = path.resolve("../../.tmp/tool-selection-runtime-tests"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "pending-"));
  const runtime = createWorkerToolSelectionRuntime({ workerDirectory: root, cwd: root, environment: {}, readActiveSelections: () => [],
    localToolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" }, herdr: { kind: "auto" } } });
  const operation = createOperation({ limits: { totalMs: 20_000 } });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const prepare = vi.spyOn(runtime.manager, "prepare").mockImplementation(async tool => { if (tool === "codex" && prepare.mock.calls.length === 1) await pending; });
  try {
    const first = runtime.prepareWebCandidates(operation.signal, false);
    expect(await runtime.prepareWebCandidates(operation.signal, true)).toBe(false);
    release(); await first;
    expect(await runtime.prepareWebCandidates(operation.signal, true)).toBe(true);
    expect(prepare.mock.calls.map(([tool]) => tool)).toEqual(["codex", "codex", "copilot"]);
  } finally { release(); prepare.mockRestore(); try { await runtime.close(); } finally { operation.dispose(); await rm(root, { recursive: true, force: true }); } }
});

test("Herdr configuration freezes both inspected native and handshake recipes", async () => {
  const scratch = path.resolve("../../.tmp/tool-selection-runtime-tests"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "herdr-")), native = path.join(root, "codex.cjs"), daemon = path.join(root, "herdr.cjs");
  await writeFile(native, "console.log('codex-cli 1.0.0');\n"); await writeFile(daemon, "console.log('herdr 0.9.9');\n");
  const runtime = createWorkerToolSelectionRuntime({ workerDirectory: root, cwd: root, environment: process.env, readActiveSelections: () => [],
    localToolPaths: { codex: { kind: "path", path: native }, copilot: { kind: "auto" }, herdr: { kind: "path", path: daemon } },
    admitHerdr: async () => ({ state: "applied", version: "0.9.5", checkedAt: new Date().toISOString() }),
  });
  try {
    const frozen = await runtime.freezeConfiguration({ agent: "codex", agentControlMode: "herdr", model: null, args: [], recoveryLimit: 3 }, new AbortController().signal);
    expect(frozen.toolLaunch).toMatchObject({ context: "herdr", entryPath: native });
    expect(frozen.herdrLaunch).toMatchObject({ tool: "herdr", context: "herdr", entryPath: daemon });
    expect(frozen.herdrObservation?.version).toBe("0.9.5");
    await rm(native); await rm(daemon);
    expect(await runtime.freezeConfiguration(frozen, new AbortController().signal)).toBe(frozen);
  } finally { try { await runtime.close(); } finally { await rm(root, { recursive: true, force: true }); } }
});


test("background Herdr admission rechecks an unchanged target after an idle daemon exits", async () => {
  const scratch = path.resolve("../../.tmp/tool-selection-runtime-tests"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "herdr-refresh-")), daemon = path.join(root, "herdr.cjs");
  await writeFile(daemon, "console.log('herdr 0.9.9');\n");
  const now = Date.now; let elapsed = 0, running = false, launches = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
  const runtime = createWorkerToolSelectionRuntime({ workerDirectory: root, cwd: root, environment: process.env, readActiveSelections: () => [],
    localToolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" }, herdr: { kind: "path", path: daemon } },
    admitHerdr: async () => { if (!running) { running = true; launches++; } return { state: "applied", version: "0.9.5", checkedAt: new Date().toISOString() }; },
  });
  try {
    const signal = new AbortController().signal;
    await expect(runtime.prepareHerdrCandidate(signal)).resolves.toBe(true);
    expect(launches).toBe(1); running = false;
    await expect(runtime.prepareHerdrCandidate(signal)).resolves.toBe(false);
    expect(running).toBe(false);
    elapsed += 60_001;
    await expect(runtime.prepareHerdrCandidate(signal)).resolves.toBe(true);
    expect(launches).toBe(2); expect(running).toBe(true);
  } finally { try { await runtime.close(); } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); } }
});
