import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { captureProcessProof, inspectProcessProof } from "../../../src/commands/controller/process-proof.js";
import { openExecutionResourceJournal } from "../../../src/commands/worker/execution-resource-journal.js";
import { createBotCliProbe, reconcileBotCliProbe, retainedBotCliProbes } from "../../../src/commands/worker/bots/cli-probe.js";
import * as probeOwners from "../../../src/commands/worker/bots/cli-probe.js";
import { reconcileOwnedCommandBoundary, retainedOwnedCommandBoundaries, runLifecycleOwnedCommand, withOwnedCommandLifecycle, type OwnedCommandLifecycleSink } from "../../../src/commands/worker/owned-command-lifecycle.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverOrigin: "https://daynight.example", userId: id(1), workerId: id(2) };
const roots: string[] = [];
const operations: ReturnType<typeof createOperation>[] = [], probeIds = new Set<string>();
const probeOperation = (signal?: AbortSignal) => { const operation = createOperation({ ...(signal === undefined ? {} : { signal }), limits: { totalMs: 30_000 } }); operations.push(operation); return operation; };
const originalProbe = (directory: string, operation: ReturnType<typeof createOperation>, save: OwnedCommandLifecycleSink) => withOwnedCommandLifecycle(async event => {
  probeIds.add(event.resourceId);
  await save(event);
}, () => createBotCliProbe({ cwd: directory, environment: process.env }, operation));
const fixture = async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/execution-resource-journal");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "case-")); roots.push(directory);
  return { directory, identity };
};
const prepared = (resourceId = id(3)) => ({ resourceId, sequence: 1, stage: "prepared" as const, proof: null });
afterEach(async () => {
  try {
    const retained = retainedBotCliProbes().filter(probe => probeIds.has(probe.launchId));
    await Promise.all(retained.map(probe => reconcileBotCliProbe(probe.launchId)));
  } finally { for (const operation of operations.splice(0)) operation.dispose(); }
  probeIds.clear();
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("execution resource responsibility journal", () => {
  it("retains unresolved reservations across reopen and closes only their original generation", async () => {
    const options = await fixture(), journal = await openExecutionResourceJournal(options);
    await journal.sink("1")(prepared());
    const restored = await openExecutionResourceJournal(options);
    expect(await restored.read()).toEqual([{ schemaVersion: 1, identity, generation: "1", event: prepared() }]);
    await expect(restored.assertClosed()).rejects.toThrow("replacement scope is forbidden");
    await expect(restored.sink("2")({ ...prepared(), sequence: 2, stage: "stopped" })).rejects.toThrow("generation conflicts");
    await restored.sink("1")({ ...prepared(), sequence: 2, stage: "stopped" });
    await restored.assertClosed();
    await restored.sink("2")(prepared(id(4)));
    const next = await openExecutionResourceJournal(options);
    expect(next.snapshot().records.map(record => [record.generation, record.event.stage])).toEqual([["1", "stopped"], ["2", "prepared"]]);
  });

  it("does not let a late lower sequence overwrite a stopped reservation", async () => {
    const options = await fixture(), journal = await openExecutionResourceJournal(options), save = journal.sink("1");
    await save(prepared());
    await Promise.all([
      save({ ...prepared(), sequence: 3, stage: "stopped" }),
      save({ ...prepared(), sequence: 2, stage: "unknown" }),
      save(prepared()),
    ]);
    const record = JSON.parse(await readFile(path.join(options.directory, `${id(3)}.json`), "utf8"));
    expect(record.event).toEqual({ ...prepared(), sequence: 3, stage: "stopped" });
    await journal.assertClosed();
  });

  it("rejects same-sequence conflicts and ignores a late unknown after a stopped boundary", async () => {
    const options = await fixture(), journal = await openExecutionResourceJournal(options), save = journal.sink("1");
    await save(prepared());
    await expect(save({ ...prepared(), stage: "unknown" })).rejects.toThrow("sequence conflicts");
    await save({ ...prepared(), sequence: 2, stage: "stopped" });
    await save({ ...prepared(), sequence: 3, stage: "unknown" });
    expect(journal.snapshot().records[0]!.event.stage).toBe("stopped");
    await journal.drain();
    await journal.assertClosed();
  });

  it.each(["reconcile", "stopped", "unknown"] as const)("finishes a failed post-rename directory barrier through %s without reopening the boundary", async recovery => {
    const options = await fixture();
    let failNext = false, flushes = 0;
    const journal = await openExecutionResourceJournal({ ...options, syncDirectory: async () => {
      flushes++;
      if (failNext) { failNext = false; throw new Error("directory durability failed"); }
    } });
    const save = journal.sink("1");
    await save(prepared());
    failNext = true;
    await expect(save({ ...prepared(), sequence: 2, stage: "stopped" })).rejects.toThrow("directory durability failed");
    const filename = path.join(options.directory, `${id(3)}.json`);
    expect(JSON.parse(await readFile(filename, "utf8")).event.stage).toBe("stopped");
    await expect(journal.assertClosed()).rejects.toThrow("replacement scope is forbidden");
    const before = flushes;
    if (recovery === "reconcile") await journal.reconcile(id(3), { deadline: Date.now() + 1000 });
    else await save({ ...prepared(), sequence: 3, stage: recovery });
    expect(flushes).toBe(before + 1);
    expect(journal.snapshot().failures).toEqual([]);
    expect(JSON.parse(await readFile(filename, "utf8")).event).toEqual({ ...prepared(), sequence: 2, stage: "stopped" });
    await journal.drain();
    await journal.assertClosed();
  });

  it("rejects changed Worker identity, corrupted records and lost reservations", async () => {
    const options = await fixture(), journal = await openExecutionResourceJournal(options);
    await journal.sink("1")(prepared());
    await expect(openExecutionResourceJournal({ ...options, identity: { ...identity, workerId: id(5) } })).rejects.toThrow("original Worker identity");
    const filename = path.join(options.directory, `${id(3)}.json`);
    await writeFile(filename, "{");
    await expect(journal.read()).rejects.toThrow();
    await rm(filename);
    await expect(journal.read()).rejects.toThrow("lost a previously observed reservation");
  });

  it("preserves prepared responsibility when no original birth proof exists", async () => {
    const options = await fixture(), journal = await openExecutionResourceJournal(options);
    await journal.sink("1")(prepared());
    await expect(journal.reconcile(id(3), { deadline: Date.now() + 1000 })).rejects.toThrow("birth evidence is unavailable");
    await expect(journal.reconcileRetained({ generation: "1", deadline: Date.now() + 1000 })).rejects.toThrow("remain unconfirmed");
    expect(journal.snapshot().records[0]!.event).toEqual(prepared());
  });

  it("joins a probe's original delayed close while recovering an independent command", async () => {
    const options = await fixture(), journal = await openExecutionResourceJournal(options), save = journal.sink("1");
    const operation = probeOperation();
    const cancellation = new AbortController(), probeLifetime = probeOperation(cancellation.signal);
    const closing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let stoppedSaves = 0, commandId: string | undefined, reserveFailure = true;
    const probe = await originalProbe(options.directory, probeLifetime, async event => {
      if (event.stage === "stopped") { stoppedSaves++; closing.resolve(); await release.promise; }
      await save(event);
    });
    cancellation.abort();
    const originalClose = probe.close();
    let reconciled: Promise<void> | undefined;
    try {
      await closing.promise;
      await expect(runLifecycleOwnedCommand({ file: process.execPath, args: ["-e", "throw Error('must not dispatch')"], environment: process.env }, operation, async event => {
        commandId = event.resourceId;
        await save(event);
        if (event.stage === "prepared" && reserveFailure) { reserveFailure = false; throw new Error("Reservation acknowledgement failed."); }
      })).rejects.toThrow("cleanup");
      let settled = false;
      reconciled = journal.reconcileRetained({ generation: "1", deadline: Date.now() + 20_000 });
      void reconciled.then(() => { settled = true; }, () => { settled = true; });
      await vi.waitFor(() => expect(journal.snapshot().records.find(record => record.event.resourceId === commandId)?.event.stage).toBe("stopped"), { timeout: 5000 });
      expect(settled).toBe(false);
      expect(stoppedSaves).toBe(1);
      expect(retainedBotCliProbes().some(owner => owner.launchId === probe.ownership.launchId)).toBe(true);
      release.resolve();
      await Promise.all([originalClose, reconciled]);
      await journal.assertClosed();
      expect(stoppedSaves).toBe(1);
      expect(retainedBotCliProbes().some(owner => owner.launchId === probe.ownership.launchId)).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([originalClose, reconciled]);
      try {
        await probe.close();
        if (commandId !== undefined && retainedOwnedCommandBoundaries().some(owner => owner.resourceId === commandId)) await reconcileOwnedCommandBoundary(commandId, save, Date.now() + 10_000);
      } finally { operation.dispose(); }
    }
  }, 40_000);

  it.each(["prepared", "bound"] as const)("joins cancellation during the original probe's %s save before recording closure", async stage => {
    const options = await fixture(), journal = await openExecutionResourceJournal(options), save = journal.sink("1");
    const cancellation = new AbortController(), operation = probeOperation(cancellation.signal);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const observing = vi.spyOn(probeOwners, "reconcileBotCliProbe");
    let resourceId: string | undefined;
    const creating = originalProbe(options.directory, operation, async event => {
      resourceId = event.resourceId;
      await save(event);
      if (event.stage === stage) { entered.resolve(); await release.promise; }
    });
    void creating.catch(() => {});
    let reconciling: Promise<void> | undefined;
    try {
      await entered.promise;
      cancellation.abort();
      reconciling = journal.reconcileRetained({ generation: "1", deadline: Date.now() + 20_000 });
      void reconciling.catch(() => {});
      await vi.waitFor(() => expect(observing).toHaveBeenCalledWith(resourceId), { timeout: 5000 });
      expect(journal.snapshot().records[0]!.event.stage).toBe(stage);
      expect(retainedBotCliProbes().some(owner => owner.launchId === resourceId)).toBe(true);
      release.resolve();
      await expect(creating).rejects.toMatchObject({ kind: "cancelled" });
      await reconciling;
      await journal.assertClosed();
      expect(journal.snapshot().records[0]!.event).toMatchObject({ resourceId, stage: "stopped", sequence: stage === "prepared" ? 2 : 3 });
      expect(retainedBotCliProbes().some(owner => owner.launchId === resourceId)).toBe(false);
    } finally {
      cancellation.abort(); release.resolve();
      await Promise.allSettled([creating, reconciling]);
      observing.mockRestore(); operation.dispose();
    }
  }, 40_000);

  it("retains the original probe after a terminal rename whose durability barrier fails", async () => {
    const options = await fixture();
    let failSave = false;
    const journal = await openExecutionResourceJournal({ ...options, syncDirectory: async () => {
      if (failSave) throw new Error("Original probe durability barrier failed.");
    } });
    const operation = probeOperation();
    const probe = await originalProbe(options.directory, operation, journal.sink("1"));
    const resourceId = probe.ownership.launchId;
    try {
      failSave = true;
      await expect(journal.reconcileRetained({ generation: "1", deadline: Date.now() + 15_000 })).rejects.toThrow("remain unconfirmed");
      expect(JSON.parse(await readFile(path.join(options.directory, `${resourceId}.json`), "utf8")).event.stage).toBe("stopped");
      expect(journal.snapshot().failures).toContain(resourceId);
      expect(retainedBotCliProbes().some(owner => owner.launchId === resourceId)).toBe(true);
      await expect(journal.assertClosed()).rejects.toThrow("unconfirmed boundaries");
      failSave = false;
      await journal.reconcileRetained({ generation: "1", deadline: Date.now() + 15_000 });
      await journal.assertClosed();
      expect(retainedBotCliProbes().some(owner => owner.launchId === resourceId)).toBe(false);
    } finally {
      failSave = false;
      try { await probe.close(); } finally { operation.dispose(); }
    }
  }, 40_000);

  it("refuses a probe birth conflict without closing its original live boundary", async () => {
    const options = await fixture(), journal = await openExecutionResourceJournal(options);
    const operation = probeOperation();
    const probe = await originalProbe(options.directory, operation, journal.sink("1"));
    const filename = path.join(options.directory, `${probe.ownership.launchId}.json`), original = await readFile(filename, "utf8");
    try {
      const changed = JSON.parse(original);
      changed.event.proof.commandHash = changed.event.proof.commandHash === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
      await writeFile(filename, JSON.stringify(changed));
      await expect(journal.reconcileRetained({ generation: "1", deadline: Date.now() + 15_000 })).rejects.toMatchObject({
        errors: expect.arrayContaining([expect.objectContaining({ message: "Retained probe resource conflicts with its saved birth identity." })]),
      });
      expect(await inspectProcessProof(probe.ownership.process!, 15_000)).toBe("running");
      expect(retainedBotCliProbes().some(owner => owner.launchId === probe.ownership.launchId)).toBe(true);
      expect(await readFile(filename, "utf8")).toBe(JSON.stringify(changed));
    } finally {
      await writeFile(filename, original);
      try { await probe.close(); } finally { operation.dispose(); }
    }
  }, 40_000);

  it("leaves probes from another generation or journal with their original owners", async () => {
    const options = await fixture(), journal = await openExecutionResourceJournal(options);
    const other = await openExecutionResourceJournal(await fixture());
    const operation = probeOperation();
    const probes: Awaited<ReturnType<typeof createBotCliProbe>>[] = [];
    try {
      for (const save of [journal.sink("2"), other.sink("1")]) probes.push(await originalProbe(options.directory, operation, save));
      await expect(journal.reconcileRetained({ generation: "1", deadline: Date.now() + 15_000 })).rejects.toThrow("remain unconfirmed");
      for (const probe of probes) {
        expect(await inspectProcessProof(probe.ownership.process!, 15_000)).toBe("running");
        expect(retainedBotCliProbes().some(owner => owner.launchId === probe.ownership.launchId)).toBe(true);
      }
      expect(journal.snapshot().records[0]!.event.stage).toBe("bound");
      expect(other.snapshot().records[0]!.event.stage).toBe("bound");
    } finally {
      try { await Promise.all(probes.map(probe => probe.close())); } finally { operation.dispose(); }
    }
  }, 40_000);

  it("rechecks an exited original process group while refusing a missing Windows Job lease", async () => {
    const options = await fixture(), journal = await openExecutionResourceJournal(options), save = journal.sink("1");
    const child = spawn(process.execPath, ["--eval", "setInterval(()=>{},1000)"], { detached: true, windowsHide: true, stdio: "ignore" });
    const closed = once(child, "close");
    try {
      await once(child, "spawn");
      const observed = await captureProcessProof(child.pid!, 15000);
      const proof = process.platform === "win32" ? { ...observed, jobObjectName: `Local\\Daynight-${id(3)}` } : observed;
      await save(prepared()); await save({ ...prepared(), sequence: 2, stage: "bound", proof });
      child.kill(); await closed;
      const reopened = await openExecutionResourceJournal(options);
      if (process.platform === "win32") {
        await expect(reopened.reconcileRetained({ generation: "1", deadline: Date.now() + 15000 })).rejects.toMatchObject({
          errors: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("lease is unavailable") })]),
        });
        await expect(reopened.assertClosed()).rejects.toThrow("unconfirmed boundaries");
      } else {
        await reopened.reconcileRetained({ generation: "1", deadline: Date.now() + 5000 });
        await reopened.assertClosed();
        expect(reopened.snapshot().records[0]!.event).toMatchObject({ stage: "stopped", proof, sequence: 3 });
      }
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; }
  }, 30000);
});
