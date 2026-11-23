import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createWorkerToolSelectionRuntime } from "../../../src/commands/worker/tool-selection-runtime.js";

test("adopted settings get bounded checks independently of provider demand", async () => {
  const scratch = path.resolve("../../.tmp/tool-selection-runtime-tests"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "configured-")), receipt = path.join(root, "checks");
  const codex = path.join(root, process.platform === "win32" ? "codex.cjs" : "codex");
  await writeFile(codex, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(receipt)},'checked\\n');console.log(process.argv.includes('--version')?'codex-cli 1.0.0':'app-server --stdio');\n`);
  await chmod(codex, 0o755);
  const choices = { codex: { kind: "auto" as const }, copilot: { kind: "path" as const, path: path.join(root, "missing-copilot") } };
  const runtime = createWorkerToolSelectionRuntime({ workerDirectory: root, cwd: root, environment: { PATH: root, PATHEXT: ".CJS" }, readActiveSelections: () => [], localToolPaths: choices });
  const signal = new AbortController().signal, prepare = vi.spyOn(runtime.manager, "prepare");
  const now = Date.now; let elapsed = 0; const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
  try {
    expect(await runtime.checkConfiguredTools(signal)).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    runtime.setTargets({ source: "cloud", revision: "1", choices });
    const first = runtime.checkConfiguredTools(signal);
    expect(await runtime.checkConfiguredTools(signal)).toBe(false);
    expect(await first).toBe(true);
    expect(runtime.manager.snapshot().entries).toEqual([
      expect.objectContaining({ tool: "codex", state: "applied", actual: expect.objectContaining({ version: "1.0.0", executablePath: codex }) }),
      expect.objectContaining({ tool: "copilot", state: "error", error: expect.objectContaining({ code: "not_found" }) }),
    ]);
    const originalChecks = await readFile(receipt, "utf8");
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(await runtime.checkConfiguredTools(signal)).toBe(false);
    elapsed += 60_001;
    expect(await runtime.checkConfiguredTools(signal)).toBe(true);
    expect(prepare.mock.calls.slice(2).map(([tool]) => tool)).toEqual(["copilot"]);
    expect(await readFile(receipt, "utf8")).toBe(originalChecks);
    runtime.setTargets({ source: "cloud", revision: "2", choices: { codex: { kind: "path", path: path.join(root, "missing-codex") }, copilot: null } });
    expect(await runtime.checkConfiguredTools(signal)).toBe(true);
    expect(prepare.mock.calls.slice(3).map(([tool]) => tool)).toEqual(["codex"]);
    expect(runtime.manager.snapshot().entries.find(entry => entry.tool === "codex")).toMatchObject({ state: "error", error: { code: "not_found" } });
    runtime.setTargets({ source: "cloud", revision: "3", choices: { codex: { kind: "path", path: codex }, copilot: null } });
    expect(await runtime.checkConfiguredTools(signal)).toBe(true);
    expect(runtime.manager.currentSelection("codex", "web")?.entryPath).toBe(codex);
    runtime.setTargets(null);
    expect(await runtime.checkConfiguredTools(signal)).toBe(false);
  } finally { clock.mockRestore(); prepare.mockRestore(); try { await runtime.close(); } finally { await rm(root, { recursive: true, force: true }); } }
}, 30_000);

test("settings check cancellation follows changed choices and shutdown", async () => {
  const scratch = path.resolve("../../.tmp/tool-selection-runtime-tests"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "configured-cancel-"));
  const choices = { codex: { kind: "auto" as const }, copilot: { kind: "auto" as const } };
  const runtime = createWorkerToolSelectionRuntime({ workerDirectory: root, cwd: root, environment: {}, readActiveSelections: () => [], localToolPaths: choices });
  const aborted: string[] = [];
  const prepare = vi.spyOn(runtime.manager, "prepare").mockImplementation((tool, _context, operation) => new Promise(resolve => {
    operation.signal.addEventListener("abort", () => { aborted.push(tool); resolve(); }, { once: true });
  }));
  try {
    runtime.setTargets({ source: "cloud", revision: "1", choices });
    const first = runtime.checkConfiguredTools(new AbortController().signal);
    expect(prepare).toHaveBeenCalledTimes(2);
    runtime.setTargets({ source: "cloud", revision: "2", choices });
    expect(aborted).toEqual([]);
    runtime.setTargets({ source: "cloud", revision: "3", choices: { codex: null, copilot: choices.copilot } });
    expect(aborted).toEqual(["codex"]);
    await runtime.close(); await first;
    expect(aborted).toEqual(["codex", "copilot"]);
    expect(await runtime.checkConfiguredTools(new AbortController().signal)).toBe(false);
  } finally { prepare.mockRestore(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("runtime freezes inspected facts and host snapshots do no process work", async () => {
  const scratch = path.resolve("../../.tmp/tool-selection-runtime-tests"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "run-")), receipt = path.join(root, "receipt");
  const entry = path.join(root, "codex.mjs");
  await writeFile(entry, `#!/usr/bin/env node\nimport{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(receipt)},JSON.stringify(process.argv.slice(2))+'\\n');console.log(process.argv.includes('--version')?'codex-cli 1.0.0':'app-server --stdio');\n`);
  await chmod(entry, 0o755);
  const runtime = createWorkerToolSelectionRuntime({ workerDirectory: root, cwd: root, environment: {}, readActiveSelections: () => [],
    localToolPaths: { codex: { kind: "path", path: entry }, copilot: { kind: "path", path: path.join(root, "missing-copilot") } } });
  const operation = createOperation({ limits: { totalMs: 20_000 } });
  try {
    const prepare = vi.spyOn(runtime.manager, "prepare");
    const target = { source: "cloud" as const, revision: "1", choices: { codex: { kind: "path" as const, path: entry }, copilot: null } };
    await runtime.configurationOptions.prepareToolSelection({ agent: "codex", model: null, args: [] }, target, operation.signal);
    expect(runtime.configurationOptions.readToolSelectionKeys({ agent: "codex", model: null, args: [] })).toEqual({ codex: expect.any(String) });
    expect(prepare.mock.calls.map(([tool, context]) => [tool, context])).toEqual([["codex", "web"]]);
    expect(runtime.manager.snapshot().entries.map(entry => entry.tool)).toEqual(["codex"]);
    const configuration = await runtime.freezeConfiguration({ agent: "codex", model: null, args: [], recoveryLimit: 3 }, operation.signal);
    expect(configuration.toolObservation).toMatchObject({ version: "1.0.0" }); expect(configuration.toolLaunch?.entryPath).toBe(entry); expect(configuration.toolLaunch?.context).toBe("web");
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

test("tool preparation waits for authoritative targets and suspends again when they become unavailable", async () => {
  const scratch = path.resolve("../../.tmp/tool-selection-runtime-tests"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "authority-")), receipt = path.join(root, "receipt"), entry = path.join(root, "codex.mjs");
  await writeFile(entry, `#!/usr/bin/env node\nimport{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(receipt)},'probe\\n');console.log(process.argv.includes('--version')?'codex-cli 1.0.0':'app-server --stdio');\n`);
  await chmod(entry, 0o755);
  const choices = { codex: { kind: "path" as const, path: entry }, copilot: { kind: "auto" as const } };
  const runtime = createWorkerToolSelectionRuntime({ workerDirectory: root, cwd: root, environment: {}, readActiveSelections: () => [], localToolPaths: choices });
  const signal = new AbortController().signal;
  try {
    await runtime.prepareWebCandidates(signal, false);
    await expect(readFile(receipt, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(runtime.manager.currentSelection("codex", "web")).toBeUndefined();
    runtime.setTargets({ source: "local", revision: null, choices });
    await runtime.prepareNative({ agent: "codex", model: null, args: [] }, signal);
    const before = await readFile(receipt, "utf8");
    expect(before).not.toBe("");
    runtime.setTargets(null);
    await expect(runtime.prepareNative({ agent: "codex", model: null, args: [] }, signal)).rejects.toThrow("configuration is unavailable");
    expect(await readFile(receipt, "utf8")).toBe(before);
    expect(runtime.manager.currentSelection("codex", "web")).toBeUndefined();
  } finally { try { await runtime.close(); } finally { await rm(root, { recursive: true, force: true }); } }
});

test("background preparation follows Copilot demand on each refresh", async () => {
  const scratch = path.resolve("../../.tmp/tool-selection-runtime-tests"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "demand-"));
  const runtime = createWorkerToolSelectionRuntime({ workerDirectory: root, cwd: root, environment: {}, readActiveSelections: () => [],
    localToolPaths: { codex: { kind: "path", path: path.join(root, "missing-codex") }, copilot: { kind: "path", path: path.join(root, "missing-copilot") } } });
  const operation = createOperation({ limits: { totalMs: 20_000 } });
  runtime.setTargets({ source: "local", revision: null, choices: { codex: { kind: "path", path: path.join(root, "missing-codex") }, copilot: { kind: "path", path: path.join(root, "missing-copilot") } } });
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
    localToolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" } } });
  const operation = createOperation({ limits: { totalMs: 20_000 } });
  runtime.setTargets({ source: "local", revision: null, choices: { codex: { kind: "auto" }, copilot: { kind: "auto" } } });
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
