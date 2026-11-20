import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { runOwnedCommand } from "../../../src/commands/worker/owned-command.js";
import { reconcileOwnedCommandBoundary, retainedOwnedCommandBoundaries, runLifecycleOwnedCommand, withOwnedCommandLifecycle, type OwnedCommandLifecycleEvent } from "../../../src/commands/worker/owned-command-lifecycle.js";
import { startOwnedRepositoryGit } from "../../../src/repository/git-owned.js";
import { captureProcessProof, inspectProcessProof } from "../../../src/commands/controller/process-proof.js";

const roots: string[] = [];
const root = async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/owned-lifecycle");
  await mkdir(parent, { recursive: true });
  const value = await mkdtemp(path.join(parent, "command-")); roots.push(value); return value;
};
const command = (source: string) => ({ file: process.execPath, args: ["--input-type=module", "--eval", source], environment: process.env });
afterEach(async () => { await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("owned command birth handshake", () => {
  it("honors an explicit local command timeout independently of the HTTP request timeout", async () => {
    const operation = createOperation({ limits: { totalMs: 30_000, requestMs: 1 } });
    try {
      const output = await runLifecycleOwnedCommand(command("process.stdout.write('local deadline');"), operation, async () => {}, { timeoutMs: 10_000 });
      expect(output.stdout).toBe("local deadline");
      expect(retainedOwnedCommandBoundaries()).toHaveLength(0);
    } finally { operation.dispose(); }
  }, 35_000);

  it("cancels the original Job or process group including the command's child", async () => {
    const directory = await root(), checkpoint = path.join(directory, "leaf");
    const cancellation = new AbortController();
    const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: 30_000, requestMs: 30_000 } });
    const events: OwnedCommandLifecycleEvent[] = [];
    const leaf = `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(checkpoint)},String(process.pid));setInterval(()=>{},1000);`;
    const pending = withOwnedCommandLifecycle(async event => { events.push(event); }, () => runOwnedCommand(command(`import {spawn} from 'node:child_process';spawn(process.execPath,['--input-type=module','--eval',${JSON.stringify(leaf)}],{stdio:'inherit'});setInterval(()=>{},1000);`), operation)).catch((error: unknown) => error);
    let settled = false, early: unknown;
    void pending.then(error => { settled = true; early = error; });
    try {
      let pid: number | undefined;
      const deadline = Date.now() + 10_000;
      while (pid === undefined) {
        try { pid = Number(await readFile(checkpoint, "utf8")); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
        if (settled) throw early;
        if (Date.now() >= deadline) throw new Error("Owned command descendant did not start.");
        if (pid === undefined) await new Promise(resolve => setTimeout(resolve, 10));
      }
      const originalLeaf = await captureProcessProof(pid);
      cancellation.abort(new Error("stop fixture boundary"));
      const error = await pending;
      expect(error).toBe(operation.signal.reason);
      expect(events.at(-1)?.stage).toBe("stopped");
      // Job membership can be empty before Windows finishes process object teardown.
      await vi.waitFor(async () => expect(await inspectProcessProof(originalLeaf)).toBe("stopped"), { timeout: 5000, interval: 25 });
      expect(retainedOwnedCommandBoundaries()).toHaveLength(0);
    } finally { cancellation.abort(); await pending; operation.dispose(); }
  }, 35_000);

  it("routes repository Git through the committed launcher boundary", async () => {
    const directory = await root(), events: OwnedCommandLifecycleEvent[] = [];
    const operation = createOperation({ limits: { totalMs: 30_000, requestMs: 30_000 } });
    try {
      const handle = withOwnedCommandLifecycle(async event => { events.push(event); }, () => startOwnedRepositoryGit(directory, ["--version"], operation));
      const result = await handle.outcome;
      expect(result.kind).toBe("success");
      if (result.kind === "success") expect(result.result.stdout).toContain("git version");
      await expect(handle.joined).resolves.toEqual({ kind: "local-closed", cleanupErrors: [] });
      expect(events.map(event => event.stage)).toEqual(["prepared", "bound", "stopped"]);
    } finally { operation.dispose(); }
  }, 35_000);

  it("commits the original boundary before executing a real command and saves its complete stop", async () => {
    const directory = await root(), checkpoint = path.join(directory, "bound.json");
    const events: OwnedCommandLifecycleEvent[] = [];
    const operation = createOperation({ limits: { totalMs: 30_000, requestMs: 30_000 } });
    try {
      const output = await withOwnedCommandLifecycle(async event => {
        events.push(event);
        if (event.stage === "bound") await writeFile(checkpoint, JSON.stringify(event));
      }, () => runOwnedCommand(command(`import {readFileSync} from 'node:fs';const saved=JSON.parse(readFileSync(${JSON.stringify(checkpoint)},'utf8'));process.stdout.write(saved.resourceId);`), operation));
      expect(events.map(event => event.stage)).toEqual(["prepared", "bound", "stopped"]);
      expect(output.stdout).toBe(events[0]!.resourceId);
      expect(events[1]!.proof?.pid).toBeGreaterThan(0);
      expect(events[2]!.proof).toEqual(events[1]!.proof);
      expect(JSON.parse(await readFile(checkpoint, "utf8")).resourceId).toBe(events[0]!.resourceId);
      expect(retainedOwnedCommandBoundaries()).toHaveLength(0);
    } finally { operation.dispose(); }
  }, 35_000);

  it("does not run user code when the boundary commit fails", async () => {
    const directory = await root(), checkpoint = path.join(directory, "forbidden");
    const events: OwnedCommandLifecycleEvent[] = [];
    const operation = createOperation({ limits: { totalMs: 30_000, requestMs: 30_000 } });
    try {
      await expect(withOwnedCommandLifecycle(async event => {
        events.push(event);
        if (event.stage === "bound") throw new Error("boundary write failed");
      }, () => runOwnedCommand(command(`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(checkpoint)},'executed');`), operation))).rejects.toThrow("boundary write failed");
      await expect(readFile(checkpoint)).rejects.toMatchObject({ code: "ENOENT" });
      expect(events.map(event => event.stage)).toEqual(["prepared", "bound", "stopped"]);
      expect(retainedOwnedCommandBoundaries()).toHaveLength(0);
    } finally { operation.dispose(); }
  }, 35_000);

  it("refuses spawning when reservation persistence fails", async () => {
    const operation = createOperation();
    try {
      await expect(withOwnedCommandLifecycle(async () => { throw new Error("reservation write failed"); }, () => runOwnedCommand(command("process.exit(99)"), operation))).rejects.toThrow("reservation write failed");
      expect(retainedOwnedCommandBoundaries()).toHaveLength(0);
    } finally { operation.dispose(); }
  });

  it("retains the original boundary when stop persistence fails and reconciles without replay", async () => {
    const operation = createOperation({ limits: { totalMs: 30_000, requestMs: 30_000 } });
    const events: OwnedCommandLifecycleEvent[] = [];
    try {
      await expect(withOwnedCommandLifecycle(async event => {
        events.push(event);
        if (event.stage === "stopped") throw new Error("stop write failed");
      }, () => runOwnedCommand(command("process.stdout.write('once');"), operation))).rejects.toMatchObject({ cause: { message: "stop write failed" } });
      expect(events.map(event => event.stage)).toEqual(["prepared", "bound", "stopped", "unknown"]);
      expect(retainedOwnedCommandBoundaries()).toHaveLength(1);
      await reconcileOwnedCommandBoundary(events[0]!.resourceId, async event => { events.push(event); }, Date.now() + 10_000);
      expect(events.at(-1)?.stage).toBe("stopped");
      expect(retainedOwnedCommandBoundaries()).toHaveLength(0);
    } finally { operation.dispose(); }
  }, 35_000);
});
