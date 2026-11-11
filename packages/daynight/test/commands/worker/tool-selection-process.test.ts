import path from "node:path";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { toolCommand } from "../../../src/platform/tool-executables.js";
import { runHerdrCommand } from "../../../src/commands/worker/herdr/command.js";
import { ToolSelectionManager } from "../../../src/commands/worker/tool-selection.js";

test("real child processes use the selected recipe while old frozen execution stays on A", async () => {
  const scratch = path.resolve("../../.tmp/tool-selection-process-tests"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "run-"));
  const operation = createOperation({ limits: { totalMs: 20_000 } });
  const script = async (label: string) => {
    const file = path.join(root, `${label}.js`);
    await writeFile(file, `#!/usr/bin/env node\nconsole.log(process.argv.includes('--version') ? '${label === "A" ? "1.0.0" : "2.0.0"}' : '${label}');\n`);
    await chmod(file, 0o755); return file;
  };
  const manager = new ToolSelectionManager({ cwd: root, environment: process.env, readActiveSelections: () => [], probe: {
    check: async launch => ({ version: (await runHerdrCommand({ ...toolCommand(launch, ["--version"]), cwd: root, environment: process.env }, operation)).stdout.trim() }), close: async () => {},
  } });
  try {
    const first = await script("A"), second = await script("B");
    const target = (file: string, revision: string) => manager.setTargets({ source: "cloud", revision, choices: { codex: { kind: "path", path: file }, copilot: { kind: "auto" }, herdr: { kind: "auto" } } });
    target(first, "1"); const frozen = await manager.selectForNewExecution("codex", "web", operation);
    expect(manager.observationFor(frozen)?.version).toBe("1.0.0");
    target(second, "2"); const next = await manager.selectForNewExecution("codex", "web", operation);
    expect(next.selectionKey).not.toBe(frozen.selectionKey); expect(manager.observationFor(next)?.version).toBe("2.0.0");
    expect((await runHerdrCommand({ ...toolCommand(frozen, []), cwd: root, environment: process.env }, operation)).stdout.trim()).toBe("A");
    expect((await runHerdrCommand({ ...toolCommand(next, []), cwd: root, environment: process.env }, operation)).stdout.trim()).toBe("B");
    await rm(first); await expect(manager.verifyFrozen(frozen, operation)).rejects.toMatchObject({ code: "tool_identity_changed" });
    expect((await manager.selectForNewExecution("codex", "web", operation)).selectionKey).toBe(next.selectionKey);
  } finally { try { await manager.close(operation); } finally { operation.dispose(); await rm(root, { recursive: true, force: true }); } }
});
