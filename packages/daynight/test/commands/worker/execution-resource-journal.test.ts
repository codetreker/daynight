import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureProcessProof } from "../../../src/commands/controller/process-proof.js";
import { openExecutionResourceJournal } from "../../../src/commands/worker/execution-resource-journal.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverOrigin: "https://daynight.example", userId: id(1), workerId: id(2) };
const roots: string[] = [];
const fixture = async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/execution-resource-journal");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "case-")); roots.push(directory);
  return { directory, identity };
};
const prepared = (resourceId = id(3)) => ({ resourceId, sequence: 1, stage: "prepared" as const, proof: null });
afterEach(async () => { await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

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
