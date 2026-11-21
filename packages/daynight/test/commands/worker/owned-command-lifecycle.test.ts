import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { runOwnedCommand } from "../../../src/commands/worker/owned-command.js";
import { reconcileOwnedCommandBoundary, retainedOwnedCommandBoundaries, runLifecycleOwnedCommand, withOwnedCommandLifecycle, type OwnedCommandLifecycleEvent } from "../../../src/commands/worker/owned-command-lifecycle.js";
import { startOwnedRepositoryGit } from "../../../src/repository/git-owned.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as windowsJob from "../../../src/commands/controller/windows-job.js";
import * as childProcesses from "node:child_process";
import * as suspendedChildren from "../../../src/commands/worker/suspended-node-child.js";
import { captureProcessProof, inspectProcessProof } from "../../../src/commands/controller/process-proof.js";

vi.mock("node:child_process", { spy: true });

const roots: string[] = [];
const root = async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/owned-lifecycle");
  await mkdir(parent, { recursive: true });
  const value = await mkdtemp(path.join(parent, "command-")); roots.push(value); return value;
};
const command = (source: string) => ({ file: process.execPath, args: ["--input-type=module", "--eval", source], environment: process.env });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("owned command birth handshake", () => {
  it.skipIf(process.platform === "win32").each(["spawn", "birth-message"] as const)("joins the original birth before stopping when cancellation arrives at %s", async phase => {
    const directory = await root(), marker = path.join(directory, "must-not-run");
    const cancellation = new AbortController(), events: OwnedCommandLifecycleEvent[] = [];
    const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: 30_000, requestMs: 30_000 } });
    const original = childProcesses.spawn;
    let cancelledBeforeProof = false;
    vi.spyOn(childProcesses, "spawn").mockImplementationOnce((...args: Parameters<typeof original>) => {
      const child = original(...args);
      child.once(phase === "spawn" ? "spawn" : "message", () => {
        cancelledBeforeProof = events.every(event => event.stage !== "bound");
        cancellation.abort(new Error(`cancel at ${phase}`));
      });
      return child;
    });
    try {
      const error = await runLifecycleOwnedCommand(command(`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');`), operation,
        async event => { events.push(event); }).catch(cause => cause);
      expect(error).toBe(operation.signal.reason);
      expect(cancelledBeforeProof).toBe(true);
      expect(events.map(event => event.stage)).toEqual(["prepared", "bound", "stopped"]);
      expect(events[1]!.proof?.processGroupId).toBe(events[1]!.proof?.pid);
      expect(events[2]!.proof).toEqual(events[1]!.proof);
      expect(await inspectProcessProof(events[1]!.proof!)).toBe("stopped");
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(retainedOwnedCommandBoundaries()).toHaveLength(0);
    } finally { cancellation.abort(); operation.dispose(); }
  }, 35_000);

  it.skipIf(process.platform === "win32")("retains the original pending birth when a reconciliation observation expires", async () => {
    const directory = await root(), marker = path.join(directory, "must-not-run");
    const cancellation = new AbortController(), events: OwnedCommandLifecycleEvent[] = [];
    const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: 30_000, requestMs: 30_000 } });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const original = processProof.captureProcessProof;
    const capture = vi.spyOn(processProof, "captureProcessProof").mockImplementationOnce(async (pid, budget) => {
      const proof = await original(pid, budget);
      entered.resolve(); await release.promise; return proof;
    });
    const pending = runLifecycleOwnedCommand(command(`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');`), operation,
      async event => { events.push(event); }).catch(cause => cause);
    try {
      await Promise.race([entered.promise, pending.then(result => { throw new Error("Owned command ended before its birth observation barrier.", { cause: result }); })]);
      cancellation.abort(new Error("cancel during native birth capture"));
      const resourceId = events[0]!.resourceId;
      await expect(reconcileOwnedCommandBoundary(resourceId, async event => { events.push(event); }, Date.now() + 25)).rejects.toThrow();
      expect(events.map(event => event.stage)).toEqual(["prepared"]);
      expect(retainedOwnedCommandBoundaries()).toEqual([{ resourceId, proof: null }]);
      expect(capture).toHaveBeenCalledOnce();
      release.resolve();
      expect(await pending).toBe(operation.signal.reason);
      expect(events.map(event => event.stage)).toEqual(["prepared", "bound", "stopped"]);
      expect(events.every(event => event.resourceId === resourceId)).toBe(true);
      expect(await inspectProcessProof(events[1]!.proof!)).toBe("stopped");
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(retainedOwnedCommandBoundaries()).toHaveLength(0);
      expect(capture).toHaveBeenCalledOnce();
    } finally { release.resolve(); cancellation.abort(); await pending; operation.dispose(); }
  }, 35_000);

  it.skipIf(process.platform === "win32").each(["birth-probe-failed", "budget-cancelled"])("retains unknown POSIX boundary responsibility after %s and a runnable launcher closes", async mode => {
    const directory = await root();
    // Isolate the intentionally unresolved receipt in its owning test process.
    // An empty PATH makes the real launcher's ps fail without creating a helper;
    // this fixture can finish while the production owner correctly stays unknown.
    const source = `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const spawn = cp.spawn, children = [];
      cp.spawn = (...args) => {
        const child = spawn(...args), observed = { pid: child.pid, spawned: false, closed: false };
        children.push(observed);
        child.once('spawn', () => { observed.spawned = true; });
        child.once('close', () => { observed.closed = true; });
        return child;
      };
      syncBuiltinESMExports();
      const lifecycle = await import(${JSON.stringify(new URL("../../../dist/commands/worker/owned-command-lifecycle.js", import.meta.url).href)});
      const { createOperation } = await import(${JSON.stringify(new URL("../../../dist/api/operation.js", import.meta.url).href)});
      const cancellation = new AbortController();
      const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: 5000, requestMs: 5000 } }), events = [];
      if (${JSON.stringify(mode)} === 'budget-cancelled') {
        const remaining = operation.remainingMs;
        operation.remainingMs = () => { cancellation.abort(new Error('cancel before dispatch budget')); return remaining(); };
      }
      const failure = await lifecycle.runLifecycleOwnedCommand({ file: process.execPath, args: [], environment: process.env }, operation, async event => { events.push(event); }).catch(error => error);
      let rejected = false;
      try { await lifecycle.reconcileOwnedCommandBoundary(events[0].resourceId, async event => { events.push(event); }, Date.now() + 1000); } catch { rejected = true; }
      operation.dispose();
      process.stdout.write(JSON.stringify({ children, events, failure: failure.name, rejected, retained: lifecycle.retainedOwnedCommandBoundaries() }));
    `;
    const output = await new Promise<string>((resolve, reject) => childProcesses.execFile(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: directory, env: { ...process.env, PATH: directory }, timeout: 10_000, maxBuffer: 1024 * 1024,
    }, (error, stdout) => error === null ? resolve(stdout) : reject(error)));
    const result = JSON.parse(output);
    expect(result.children).toEqual([{ pid: expect.any(Number), spawned: true, closed: true }]);
    expect(result.events.map((event: OwnedCommandLifecycleEvent) => event.stage)).toEqual(["prepared", "unknown"]);
    expect(result.failure).toBe("OwnedCommandCleanupError");
    expect(result.rejected).toBe(true);
    expect(result.retained).toEqual([{ resourceId: result.events[0].resourceId, proof: null }]);
  }, 15_000);

  it.skipIf(process.platform !== "win32")("joins the never-resumed Windows launcher when reading the dispatch budget observes cancellation", async () => {
    const cancellation = new AbortController();
    const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: 30_000, requestMs: 30_000 } });
    const remaining = operation.remainingMs;
    const spawned = vi.spyOn(childProcesses, "spawn"), suspended = vi.spyOn(suspendedChildren, "createSuspendedNodeChild");
    const events: OwnedCommandLifecycleEvent[] = [];
    vi.spyOn(operation, "remainingMs").mockImplementationOnce(() => {
      cancellation.abort(new Error("cancel before dispatch budget"));
      return remaining();
    });
    try {
      const error = await runLifecycleOwnedCommand(command("process.exit(0)"), operation, async event => { events.push(event); }).catch(cause => cause);
      expect(error).toBe(operation.signal.reason);
      expect(events.map(event => event.stage)).toEqual(["prepared", "stopped"]);
      expect(retainedOwnedCommandBoundaries()).toHaveLength(0);
    } finally {
      // Retain direct handles in the fixture so a regression cannot leave its
      // never-dispatched launcher alive after the failed assertion.
      if (retainedOwnedCommandBoundaries().some(boundary => boundary.resourceId === events[0]?.resourceId)) {
        const native = await suspended.mock.results[0]?.value;
        const child = native?.child ?? spawned.mock.results[0]?.value;
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
          child.kill("SIGKILL");
          await closed;
        }
        native?.closeHandles();
      }
      operation.dispose();
    }
  }, 35_000);

  it("closes a reservation when the operating system rejects process creation", async () => {
    const directory = await root();
    const events: OwnedCommandLifecycleEvent[] = [];
    const operation = createOperation({ limits: { totalMs: 30_000, requestMs: 30_000 } });
    try {
      await expect(runLifecycleOwnedCommand({ ...command("process.exit(0)"), cwd: path.join(directory, "missing") }, operation,
        async event => { events.push(event); })).rejects.toThrow();
      expect(events.map(event => event.stage)).toEqual(["prepared", "stopped"]);
      expect(retainedOwnedCommandBoundaries()).toHaveLength(0);
    } finally { operation.dispose(); }
  }, 35_000);

  it.skipIf(process.platform !== "win32")("rounds the absolute Job lease deadline when the operation has fractional milliseconds", async () => {
    const operation = createOperation({ limits: { totalMs: 5000, requestMs: 5000 } });
    const original = operation.remainingMs;
    vi.spyOn(operation, "remainingMs").mockImplementation(() => Math.min(original(), 4999.25));
    const acquire = vi.spyOn(windowsJob, "createControllerJobLease");
    try {
      const output = await runLifecycleOwnedCommand(command("process.stdout.write('fractional budget');"), operation, async () => {});
      expect(output.stdout).toBe("fractional budget");
      expect(acquire).toHaveBeenCalledOnce();
      expect(Number.isSafeInteger(acquire.mock.calls[0]![2])).toBe(true);
      expect(retainedOwnedCommandBoundaries()).toHaveLength(0);
    } finally { operation.dispose(); }
  }, 35_000);

  it("refuses dispatch when cancellation arrives during the final birth observation", async () => {
    const directory = await root(), checkpoint = path.join(directory, "cancelled-dispatch");
    const cancellation = new AbortController();
    const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: 30_000, requestMs: 30_000 } });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const original = processProof.inspectProcessProof;
    vi.spyOn(processProof, "inspectProcessProof").mockImplementationOnce(async (proof, budget) => {
      const state = await original(proof, budget);
      entered.resolve(); await release.promise; return state;
    });
    const events: OwnedCommandLifecycleEvent[] = [];
    const pending = runLifecycleOwnedCommand(command(`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(checkpoint)},'executed');`), operation,
      async event => { events.push(event); }).then(value => ({ value }), error => ({ error }));
    try {
      await Promise.race([entered.promise, pending.then(result => { throw new Error("Owned command ended before the final observation barrier.", { cause: result }); })]);
      cancellation.abort(new Error("cancel before native dispatch"));
      release.resolve();
      expect(await pending).toEqual({ error: operation.signal.reason });
      await expect(readFile(checkpoint)).rejects.toMatchObject({ code: "ENOENT" });
      expect(events.map(event => event.stage)).toEqual(["prepared", "bound", "stopped"]);
      expect(retainedOwnedCommandBoundaries()).toHaveLength(0);
    } finally { release.resolve(); cancellation.abort(); await pending; operation.dispose(); }
  }, 35_000);

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
    let resourceId: string | undefined;
    try {
      await expect(withOwnedCommandLifecycle(async event => { resourceId = event.resourceId; throw new Error("reservation write failed"); }, () => runOwnedCommand(command("process.exit(99)"), operation))).rejects.toMatchObject({ cause: { message: "reservation write failed" } });
      expect(retainedOwnedCommandBoundaries()).toEqual([{ resourceId, proof: null }]);
    } finally {
      operation.dispose();
      if (resourceId !== undefined) await reconcileOwnedCommandBoundary(resourceId, async () => {}, Date.now() + 1000);
    }
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
