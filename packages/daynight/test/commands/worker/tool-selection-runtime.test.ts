import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
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
    await runtime.prepareWebCandidates(operation.signal);
    const configuration = await runtime.freezeConfiguration({ agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 }, operation.signal);
    expect(configuration.toolObservation).toMatchObject({ version: "1.0.0" }); expect(configuration.toolLaunch?.entryPath).toBe(entry);
    const before = await readFile(receipt, "utf8");
    expect(await runtime.hostInspector.check(configuration.toolLaunch!, operation)).toEqual(configuration.toolObservation);
    runtime.manager.snapshot(); expect(await readFile(receipt, "utf8")).toBe(before);
    expect(before.trim().split("\n")).toHaveLength(2);
    await rm(entry);
    await expect(runtime.manager.prepare("codex", "web", operation)).rejects.toMatchObject({ code: "tool_identity_changed" });
    expect(runtime.manager.currentSelection("codex", "web")).toBeUndefined();
    await expect(runtime.hostInspector.check(configuration.toolLaunch!, operation)).rejects.toThrow("no current inspection proof");
    expect(await runtime.freezeConfiguration(configuration, operation.signal)).toBe(configuration);
  } finally { try { await runtime.close(); } finally { operation.dispose(); await rm(root, { recursive: true, force: true }); } }
});
