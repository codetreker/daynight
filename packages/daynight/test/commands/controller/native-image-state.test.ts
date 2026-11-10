import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { captureProcessProof } from "../../../src/commands/controller/process-proof.js";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = path.resolve("../../.tmp/native-image-state-tests");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "state-")); directories.push(home);
  const ticket: ControllerLaunchTicket = {
    schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(),
    sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(),
    claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home,
    nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 },
    initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"),
    ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString(),
  };
  const file = path.join(home, "journal.sqlite");
  return { file, ticket, open: () => openControllerLifecycleStore(file, ticket) };
};

test("native aliases and page cursors survive journal reopen without modifying caller-owned values", async () => {
  const f = await fixture(); const original = { nativeSessionId: "native", cursor: "page-2", aliases: ["item-1"] };
  let journal = f.open();
  try {
    expect(journal.readNativeImageState("history")).toBeNull();
    journal.writeNativeImageState("history", original);
    original.aliases.push("not-persisted");
    expect(journal.readNativeImageState("history")).toEqual({ nativeSessionId: "native", cursor: "page-2", aliases: ["item-1"] });
  } finally { journal.close(); }
  journal = f.open();
  try {
    const saved = journal.readNativeImageState("history") as typeof original;
    saved.aliases.push("not-persisted-either");
    expect(journal.readNativeImageState("history")).toEqual({ nativeSessionId: "native", cursor: "page-2", aliases: ["item-1"] });
  } finally { journal.close(); }
});

test("native metadata refuses oversized or non-JSON values before replacing saved state", async () => {
  const f = await fixture(); const journal = f.open();
  try {
    journal.writeNativeImageState("receipt", { nativeMessageId: "original" });
    expect(() => journal.writeNativeImageState("receipt", { value: "x".repeat(1_048_576) })).toThrow(/metadata/);
    expect(() => journal.writeNativeImageState("receipt", undefined)).toThrow(/metadata/);
    expect(() => journal.writeNativeImageState("", {})).toThrow(/key/);
    expect(() => journal.writeNativeImageState("provider_images\0", {})).toThrow(/key/);
    expect(journal.readNativeImageState("receipt")).toEqual({ nativeMessageId: "original" });
  } finally { journal.close(); }
});

test("native wire spools enforce bounds and retain their files until readers finish", async () => {
  const f = await fixture(); const journal = f.open();
  try {
    const spool = journal.media().createSpool(70_000);
    expect(() => spool.write(new Uint8Array(65_537))).toThrow(/chunk/);
    spool.write(new Uint8Array(65_536).fill(17));
    spool.write(new Uint8Array(4_464).fill(29));
    expect(() => spool.write(new Uint8Array(1))).toThrow(/bound/);
    expect(() => [...spool.read()]).toThrow(/sealed/);
    spool.seal();
    expect(() => spool.write(new Uint8Array(1))).toThrow(/sealed/);
    const reader = spool.read()[Symbol.iterator]();
    try {
      expect(new Uint8Array(reader.next().value!)).toEqual(new Uint8Array(65_536).fill(17));
      expect(() => spool.remove()).toThrow(/reader/);
      expect(new Uint8Array(reader.next().value!)).toEqual(new Uint8Array(4_464).fill(29));
      expect(reader.next().done).toBe(true);
    } finally { reader.return?.(); }
    spool.remove();
    await expect(access(spool.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => [...spool.read()]).toThrow(/removed/);
    spool.remove();
  } finally { await journal.stopMedia(); journal.close(); }
});

test("large wire allowances retain only the bytes actually written", async () => {
  const f = await fixture(); const journal = f.open();
  let ledger: Database.Database | undefined;
  try {
    // Two 128 MiB allowances must charge only their actual prefixes. The file
    // budget remains shared with uploads; a maximum is not an eager allocation.
    const a = journal.media().createSpool(128 * 1_048_576), b = journal.media().createSpool(128 * 1_048_576);
    ledger = new Database(path.join(path.dirname(f.file), "controller/media/budget.sqlite"), { readonly: true });
    const charged = () => (ledger!.prepare("SELECT reserved_bytes AS bytes FROM allocations WHERE execution_id=?").get(f.ticket.executionId) as { bytes: number }).bytes;
    const initial = charged();
    a.write(new Uint8Array([1])); b.write(new Uint8Array([2])); a.seal(); b.seal();
    expect(charged() - initial).toBe(2);
    expect([...a.read()].map(bytes => [...bytes])).toEqual([[1]]);
    expect([...b.read()].map(bytes => [...bytes])).toEqual([[2]]);
    a.remove(); b.remove();
    expect(charged()).toBe(initial);
  } finally { ledger?.close(); await journal.stopMedia(); journal.close(); }
});

test("an index writer owns a durable shared metadata reservation until it explicitly joins", async () => {
  const f = await fixture(); let journal = f.open();
  try {
    const lease = journal.acquireNativeIndexReservation(64 * 1_048_576);
    expect(() => journal.media().reserveNativeIndex(80 * 1_048_576)).toThrow(/metadata/);
    expect(() => journal.acquireNativeIndexReservation(1)).toThrow(/writer/);
    lease.release();
    expect(() => journal.media().reserveNativeIndex(80 * 1_048_576)).not.toThrow();
    journal.acquireNativeIndexReservation(64 * 1_048_576);
    await journal.stopMedia();
  } finally { journal.close(); }
  journal = f.open();
  try {
    expect(() => journal.media().reserveNativeIndex(80 * 1_048_576)).toThrow(/metadata/);
    expect(() => journal.acquireNativeIndexReservation(1)).toThrow(/writer/);
  } finally { await journal.stopMedia(); journal.close(); }
});

test("index reservations recover only after the original writer's process identity is proven stopped", async () => {
  const f = await fixture(); let journal = f.open();
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const owner = await captureProcessProof(child.pid!);
    journal.acquireNativeIndexReservation(64 * 1_048_576, owner);
    journal.close(); journal = f.open();
    await expect(journal.reconcileNativeIndexReservation()).rejects.toThrow(/writer/);
    expect(() => journal.acquireNativeIndexReservation(1)).toThrow(/writer/);
    child.stdin!.end(); await exited;
    await journal.reconcileNativeIndexReservation();
    const next = journal.acquireNativeIndexReservation(80 * 1_048_576); next.release();
  } finally { child.kill(); await exited; await journal.stopMedia(); journal.close(); }
});
