import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createWorkerToolSelectionRuntime } from "../../../src/commands/worker/tool-selection-runtime.js";

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
