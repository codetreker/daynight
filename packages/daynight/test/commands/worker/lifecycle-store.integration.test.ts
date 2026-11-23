import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import * as filesystem from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleAdmissionError, openLifecycleStore, readLifecycleSnapshot, type LifecycleActivation, type LifecycleBinding, type LifecycleStore } from "../../../src/commands/worker/lifecycle-store.js";

const fileIdentity = vi.hoisted(() => ({ file: null as string | null, inode: 0n }));
vi.mock("node:fs", async (importOriginal: () => Promise<typeof filesystem>) => {
  const actual = await importOriginal();
  return { ...actual, lstatSync: ((file: filesystem.PathLike, options?: filesystem.StatOptions) => {
    const info = actual.lstatSync(file, options);
    if (file !== fileIdentity.file || info === undefined) return info;
    return new Proxy(info, { get: (target, key, receiver) => key === "ino"
      ? options?.bigint ? fileIdentity.inode : Number(fileIdentity.inode)
      : Reflect.get(target, key, receiver) });
  }) as typeof filesystem.lstatSync };
});

const root = fileURLToPath(new URL("../../../../../.tmp/lifecycle-store-tests/", import.meta.url));
const directories: string[] = [], stores = new Set<LifecycleStore>(), databases = new Set<Database.Database>();
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverOrigin: "https://daynight.example", userId: id(1), workerId: id(2) };
const open = (file: string, allowCreate = false): LifecycleStore => { const store = openLifecycleStore({ file, identity, allowCreate }); stores.add(store); return store; };
const close = (store: LifecycleStore): void => { store.close(); stores.delete(store); };
const fixture = () => {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, "authority-")); chmodSync(directory, 0o700); directories.push(directory);
  const file = path.join(directory, "lifecycle.sqlite"), store = open(file, true);
  return { directory, file, store };
};
const binding = (store: LifecycleStore): LifecycleBinding => {
  const state = store.readState();
  return { ...identity, instanceId: state.instanceId!, instanceEpoch: state.instanceEpoch!, localEpoch: state.localEpoch, intentVersion: state.intentVersion!, scopeGeneration: state.scopeGeneration };
};
const ready = (store: LifecycleStore): void => {
  const current = store.snapshot(); store.markStopped({ localEpoch: current.state.localEpoch, inventoryRevision: current.inventoryRevision, owners: [] });
};
const activate = (store: LifecycleStore, action: LifecycleActivation["action"] = "bootstrap", operationId = id(5)): LifecycleBinding => {
  const frozen = binding(store), generation = action === "bootstrap" ? frozen.scopeGeneration : String(BigInt(frozen.scopeGeneration) + 1n);
  const activation = { binding: { ...frozen, scopeGeneration: generation }, operationId, action };
  store.prepareActivation(activation);
  store.commitActivation({ ...activation, receipt: { protocolVersion: 1, action, admission: "open", operationId, workerId: identity.workerId, instanceEpoch: frozen.instanceEpoch, localEpoch: frozen.localEpoch, intentVersion: frozen.intentVersion, scopeGeneration: generation } });
  return activation.binding;
};
const enabled = () => {
  const f = fixture(); f.store.bindInstance({ instanceId: id(3), instanceEpoch: "1", intentVersion: "1", desired: "enabled" }); ready(f.store);
  return { ...f, binding: activate(f.store) };
};
const reserve = (store: LifecycleStore, frozen: LifecycleBinding, resourceId = id(10)) => store.reserveExecution({ binding: frozen, resourceId, operationId: resourceId, ownerKind: "controller", identity: { sessionId: id(4), operationId: resourceId } });

afterEach(() => {
  fileIdentity.file = null;
  for (const store of stores) store.close(); stores.clear();
  for (const db of databases) if (db.open) db.close(); databases.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("persistent Worker lifecycle authority", () => {
  it("reserves only cleanup commands under the original scope after local veto and intent changes", () => {
    const f = enabled(), task = { projectId: id(20), taskId: id(21), claimId: id(22) };
    f.store.closeAdmission({ operationId: id(23), local: true });
    f.store.observeAuthority({ intentVersion: "2", desired: "disabled", admission: "closed" });
    const current = binding(f.store);
    expect(() => f.store.reserveCleanupCommand({ binding: f.binding, task, resourceId: id(24) })).toThrow("binding is stale");
    expect(() => reserve(f.store, current, id(24))).toThrow(LifecycleAdmissionError);
    const resource = f.store.reserveCleanupCommand({ binding: current, task, resourceId: id(24) });
    expect(resource).toMatchObject({ instanceId: f.binding.instanceId, instanceEpoch: f.binding.instanceEpoch, scopeGeneration: f.binding.scopeGeneration, stage: "reserved", identity: { kind: "cleanup_command", ...task } });
    expect(f.store.readState()).toMatchObject({ admission: "closed", localVeto: true, desired: "disabled" });
    expect(f.store.snapshot().counts.pending).toBe(1);
    f.store.recordResource({ resourceId: resource.resourceId, stage: "stopped", stopProof: { kind: "owned_boundary", sequence: 3 }, saveState: "durable" });
    expect(f.store.snapshot().counts.pending).toBe(0);
    expect(() => f.store.reserveCleanupCommand({ binding: { ...current, instanceId: id(25) }, task, resourceId: id(26) })).toThrow(LifecycleAdmissionError);
    expect(() => f.store.reserveCleanupCommand({ binding: { ...current, scopeGeneration: "2" }, task, resourceId: id(26) })).toThrow(LifecycleAdmissionError);
    expect(f.store.readResource(id(26))).toBeNull();
  });

  it("preserves large filesystem identifiers and rejects a replacement with the same rounded Number", () => {
    const f = fixture(); close(f.store);
    fileIdentity.file = f.file; fileIdentity.inode = 9007199254740992n;
    try {
      const original = open(f.file);
      expect(original.readState().admission).toBe("closed");
      expect(() => original.prepareOperation({ operationId: id(70), kind: "instance", request: { unsafe: Number(fileIdentity.inode) } })).toThrow("unsupported value");
      expect(() => original.prepareOperation({ operationId: id(71), kind: "instance", request: { unsupported: fileIdentity.inode } as never })).toThrow("unsupported value");
      fileIdentity.inode++;
      expect(Number(fileIdentity.inode)).toBe(Number(fileIdentity.inode - 1n));
      expect(() => original.readState()).toThrow("authority file was replaced");
      close(original);
    } finally { fileIdentity.file = null; }
  });

  it("creates a private closed authority and leaves missing reads uninitialized", () => {
    const f = fixture();
    expect(f.store.readState()).toMatchObject({ localEpoch: "1", scopeGeneration: "1", inventoryRevision: "1", admission: "closed", localVeto: false, bootstrapConsumed: false });
    expect(() => readLifecycleSnapshot({ file: path.join(f.directory, "missing.sqlite"), identity })).toThrow();
    close(f.store);
    expect(open(f.file).readState().admission).toBe("closed");
  });

  it("clears recovered management transport errors only under the original binding", () => {
    const f = enabled(); f.store.markManagementFailure();
    expect(f.store.readState().errorCode).toBe("authority_unavailable");
    expect(() => f.store.confirmManagementAuthority({ ...f.binding, instanceEpoch: "2" })).toThrow("binding is stale");
    expect(f.store.readState().errorCode).toBe("authority_unavailable");
    f.store.confirmManagementAuthority(f.binding);
    expect(f.store.readState()).toMatchObject({ errorCode: null, admission: "closed" });
    f.store.markBlocked("independent_blocker"); f.store.markManagementFailure();
    f.store.confirmManagementAuthority(f.binding); ready(f.store);
    expect(f.store.readState().errorCode).toBe("independent_blocker");
    expect(() => activate(f.store, "reconnect", id(40))).toThrow("independent lifecycle blocker");
  });

  it("linearizes reservation before close and rejects close-before-reservation on another connection", () => {
    const f = enabled(), peer = open(f.file);
    reserve(peer, f.binding);
    const closed = f.store.closeAdmission({ operationId: id(20), local: true });
    expect(closed).toMatchObject({ localEpoch: "2", localVeto: true, admission: "closed" });
    expect(() => reserve(peer, f.binding, id(11))).toThrow(LifecycleAdmissionError);
    expect(() => ready(peer)).toThrow("unresolved responsibility");
    expect(peer.listResources()).toHaveLength(1);
    peer.recordResource({ resourceId: id(10), stage: "not_dispatched" });
    ready(f.store);
    close(peer); close(f.store);
    expect(readLifecycleSnapshot({ file: f.file, identity })).toMatchObject({ state: { phase: "disabled", admission: "closed", localVeto: true }, inventoryComplete: true, counts: { total: 1, stopped: 1, pending: 0, blocked: 0 } });
  });

  it("retains unknown birth responsibility after reopen and requires original stop proof", () => {
    const f = enabled(); reserve(f.store, f.binding);
    const proof = { pid: 123, birth: "original" };
    f.store.recordResource({ resourceId: id(10), stage: "running", processProof: proof });
    f.store.recordResource({ resourceId: id(10), stage: "unknown", error: "Stop result unavailable" });
    f.store.closeAdmission({ operationId: id(20), local: true }); close(f.store);
    const reopened = open(f.file);
    expect(reopened.snapshot()).toMatchObject({ inventoryComplete: false, counts: { blocked: 1 }, resources: [{ processProof: proof, stage: "unknown" }] });
    expect(() => reopened.recordResource({ resourceId: id(10), stage: "confirmed" })).toThrow("stopping evidence");
    expect(() => reopened.recordResource({ resourceId: id(10), stage: "stopped", processProof: { pid: 123, birth: "reused" }, stopProof: { empty: true } })).toThrow("original birth proof");
    reopened.recordResource({ resourceId: id(10), stage: "stopped", stopProof: { originalProof: proof, boundaryEmpty: true } });
    ready(reopened);
    expect(() => reopened.recordResource({ resourceId: id(10), stage: "running" })).toThrow("terminal responsibility");
  });

  it("invalidates a frozen inventory revision when a previously admitted resource settles", () => {
    const f = enabled(); reserve(f.store, f.binding);
    const state = f.store.closeAdmission({ operationId: id(20), local: true });
    f.store.recordResource({ resourceId: id(10), stage: "not_dispatched" });
    expect(() => f.store.markStopped({ localEpoch: state.localEpoch, inventoryRevision: state.inventoryRevision })).toThrow("fence is stale");
    const current = f.store.snapshot();
    expect(() => f.store.markStopped({ localEpoch: current.state.localEpoch, inventoryRevision: current.inventoryRevision, owners: [{ resourceId: "configuration", ownerKind: "configuration", generation: "1", stop: "unknown", save: "failed" }] })).toThrow("scope owners");
    ready(f.store);
  });

  it("preserves a new local veto when an older activation receipt arrives", () => {
    const f = enabled(); f.store.closeAdmission({ operationId: id(20), local: true }); ready(f.store);
    f.store.observeAuthority({ intentVersion: "3", desired: "enabled", admission: "closed" });
    ready(f.store);
    const activation = { binding: { ...binding(f.store), scopeGeneration: "2" }, operationId: id(21), action: "resume" as const };
    f.store.prepareActivation(activation);
    f.store.closeAdmission({ operationId: id(22), local: true });
    expect(() => f.store.commitActivation({ ...activation, receipt: { protocolVersion: 1, action: "resume", admission: "open", operationId: id(21), workerId: id(2), instanceEpoch: "1", intentVersion: "3", localEpoch: "2", scopeGeneration: "2" } })).toThrow("binding is stale");
    expect(f.store.readState()).toMatchObject({ admission: "closed", localVeto: true, localEpoch: "3" });
  });

  it("requires the exact activation receipt and reopens only its prepared epoch", () => {
    const f = enabled(); f.store.closeAdmission({ operationId: id(20), local: true }); ready(f.store);
    f.store.observeAuthority({ intentVersion: "3", desired: "enabled", admission: "closed" });
    ready(f.store);
    const frozen = activate(f.store, "resume", id(21));
    expect(f.store.readState()).toMatchObject({ admission: "open", localVeto: false, scopeGeneration: "2" });
    expect(() => f.store.assertAdmission(f.binding)).toThrow(LifecycleAdmissionError);
    f.store.assertAdmission(frozen);
  });

  it("closes native admission for a normal restart while retaining the completed opening", () => {
    const f = enabled();
    f.store.closeForRestart();
    expect(() => f.store.assertAdmission(f.binding)).toThrow(LifecycleAdmissionError);
    close(f.store); const reopened = open(f.file);
    expect(reopened.readState()).toMatchObject({ admission: "closed", phase: "accepting", localVeto: false, bootstrapConsumed: true, activation: { action: "bootstrap" } });
    reopened.bindInstance({ instanceId: id(7), instanceEpoch: "2", intentVersion: "1", desired: "enabled" }); ready(reopened);
    activate(reopened, "reconnect", id(8));
    expect(reopened.readState()).toMatchObject({ admission: "open", scopeGeneration: "2", instanceEpoch: "2" });
    reopened.closeAdmission({ operationId: id(20), local: true });
    expect(reopened.closeForRestart()).toMatchObject({ phase: "disabling", admission: "closed", localVeto: true });
  });

  it("imports retained responsibility only behind closed admission and preserves its original identity", () => {
    const f = enabled();
    const input = { binding: f.binding, resourceId: id(50), ownerKind: "controller" as const, identity: { sessionId: id(4) }, operationId: id(51) };
    expect(() => f.store.importResource(input)).toThrow("closed management admission");
    f.store.closeForRestart();
    expect(f.store.importResource(input)).toMatchObject({ stage: "unknown", instanceEpoch: "1" });
    expect(() => ready(f.store)).toThrow("unresolved responsibility");
    expect(() => f.store.importResource({ ...input, identity: { sessionId: id(8) } })).toThrow("original reservation");
    expect(f.store.importResource(input)).toMatchObject({ stage: "unknown" });
  });

  it("keeps resume intent and activation outcomes under the same operation without overwriting", () => {
    const f = fixture(), operationId = id(30);
    f.store.prepareOperation({ operationId, kind: "resume", request: { action: "resume", expectedVersion: "1" } });
    f.store.recordOperation({ operationId, status: "confirmed", receipt: { intentVersion: "2" } });
    f.store.prepareOperation({ operationId, kind: "activation", phase: "activation", request: { action: "resume", intentVersion: "2" } });
    f.store.recordOperation({ operationId, phase: "activation", status: "unknown" });
    close(f.store); const reopened = open(f.file);
    expect(reopened.readOperation(operationId)).toMatchObject({ phase: "primary", status: "confirmed", receipt: { intentVersion: "2" } });
    expect(reopened.readOperation(operationId, "activation")).toMatchObject({ phase: "activation", status: "unknown", request: { action: "resume", intentVersion: "2" } });
    expect(() => reopened.prepareOperation({ operationId, kind: "activation", phase: "activation", request: { action: "resume", intentVersion: "3" } })).toThrow("frozen original payload");
    expect(reopened.listOperations()).toHaveLength(2);
  });

  it("retains full aggregate proof when resource detail exceeds its budget", () => {
    const f = enabled();
    for (let n = 100; n < 105; n++) { reserve(f.store, f.binding, id(n)); f.store.recordResource({ resourceId: id(n), stage: "confirmed" }); }
    f.store.closeAdmission({ operationId: id(20), local: true }); ready(f.store);
    const complete = f.store.snapshot(), limited = f.store.snapshot(2);
    expect(limited.resources).toHaveLength(2);
    expect(limited.detailsComplete).toBe(false);
    expect(limited.inventoryDigest).toBe(complete.inventoryDigest);
    expect(limited.counts).toEqual({ total: 5, stopped: 5, pending: 0, blocked: 0 });
    expect(limited.inventoryComplete).toBe(true);
  });

  it("uses exact integers above JavaScript's safe range and rejects overflow", () => {
    const f = fixture();
    f.store.bindInstance({ instanceId: id(3), instanceEpoch: "9007199254740993", intentVersion: "9007199254740995", desired: "enabled" });
    expect(f.store.readState()).toMatchObject({ instanceEpoch: "9007199254740993", intentVersion: "9007199254740995" });
    expect(() => f.store.bindInstance({ instanceId: id(4), instanceEpoch: "9223372036854775808", intentVersion: "9007199254740995", desired: "enabled" })).toThrow("int64");
  });

  it("keeps immutable outbox payloads and does not let an old receipt hide newer pending reports", () => {
    const f = enabled();
    for (const n of [1, 2]) f.store.appendOutbox({ id: id(40 + n), instanceEpoch: "1", intentVersion: "1", reportSequence: String(n), payload: { reportSequence: String(n) } });
    const receipt = (sequence: string) => ({ protocolVersion: 1, accepted: true, instanceEpoch: "1", intentVersion: "1", reportSequence: sequence, receivedAt: "2026-11-21T00:00:00.000Z" });
    f.store.ackOutbox(id(41), "confirmed", receipt("1")); expect(f.store.readState().sync).toBe("pending");
    f.store.ackOutbox(id(42), "confirmed", receipt("2")); expect(f.store.readState().sync).toBe("complete");
    expect(() => f.store.appendOutbox({ id: id(41), instanceEpoch: "1", intentVersion: "1", reportSequence: "1", payload: { reportSequence: "changed" } })).toThrow("frozen original report");
    close(f.store); expect(open(f.file).listOutbox()).toHaveLength(2);
  });

  it("compresses only closed resource history without changing its aggregate proof or allowing ID reuse", () => {
    const f = enabled(); reserve(f.store, f.binding);
    f.store.recordResource({ resourceId: id(10), stage: "confirmed" });
    f.store.closeAdmission({ operationId: id(20), local: true }); ready(f.store);
    const before = f.store.snapshot();
    expect(f.store.compactHistory({ beforeScopeGeneration: "2" })).toEqual({ resources: 1, outbox: 0 });
    expect(f.store.snapshot()).toEqual(before);
    expect(f.store.readResource(id(10))).toEqual(before.resources[0]);
    expect(() => f.store.recordResource({ resourceId: id(10), stage: "unknown" })).toThrow("terminal responsibility");
    close(f.store); const reopened = open(f.file);
    expect(reopened.snapshot()).toEqual(before);
    reopened.observeAuthority({ intentVersion: "3", desired: "enabled", admission: "closed" }); ready(reopened);
    const next = activate(reopened, "resume", id(22));
    expect(reopened.snapshot().counts.total).toBe(0);
    expect(reopened.readResource(id(10))).toEqual(before.resources[0]);
    expect(() => reserve(reopened, next, id(10))).toThrow("original reservation");
  });

  it("retains covered reports as coverage evidence and never compresses unknown delivery", () => {
    const f = enabled();
    for (const sequence of [1, 2, 3]) f.store.appendOutbox({ id: id(40 + sequence), instanceEpoch: "1", intentVersion: "1", reportSequence: String(sequence), payload: { sequence } });
    f.store.ackOutbox(id(41), "unknown"); f.store.ackOutbox(id(42), "unknown");
    expect(() => f.store.coverOutbox(id(41), { instanceEpoch: "1", intentVersion: "1", reportSequence: "1", receivedAt: "2026-11-21T00:00:00Z" })).toThrow("does not supersede");
    f.store.coverOutbox(id(41), { instanceEpoch: "1", intentVersion: "1", reportSequence: "3", receivedAt: "2026-11-21T00:00:00Z" });
    f.store.compactHistory();
    expect(f.store.readOutboxHistory(id(41))).toMatchObject({ uploadState: "covered", reportSequence: "1", receipt: { reportSequence: "3" } });
    expect(f.store.readOutboxHistory(id(42))).toBeNull();
    expect(f.store.listOutbox().find(row => row.id === id(42))).toMatchObject({ uploadState: "unknown" });
  });

  it("fails closed for mismatched identity, future format and invalid JSON", () => {
    const f = enabled();
    expect(() => openLifecycleStore({ file: f.file, identity: { ...identity, workerId: id(90) } })).toThrow("another identity");
    const db = new Database(f.file); databases.add(db); db.pragma("user_version=2");
    expect(() => f.store.assertAdmission(f.binding)).toThrow(); db.pragma("user_version=1");
    reserve(f.store, f.binding); db.prepare("UPDATE resource_owners SET identity_json='{}'").run();
    expect(() => f.store.snapshot()).toThrow("nonempty JSON object");
    db.close();
  });

  it("fences a real rename through the live handle or the original authority path", () => {
    const f = enabled(), retained = f.file + ".retained";
    const before = filesystem.lstatSync(f.file, { bigint: true });
    let blocked: unknown;
    try { renameSync(f.file, retained); } catch (error) { blocked = error; }
    if (blocked !== undefined) {
      expect(process.platform).toBe("win32");
      expect(blocked).toMatchObject({ code: "EBUSY", syscall: "rename" });
      expect(filesystem.existsSync(retained)).toBe(false);
      expect(filesystem.lstatSync(f.file, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino });
      expect(() => f.store.assertAdmission(f.binding)).not.toThrow();
      // Windows denies renaming the live SQLite file. Closing the original
      // handle permits the same filesystem operation; no replacement occurred.
      close(f.store);
      renameSync(f.file, retained);
    } else {
      expect(filesystem.existsSync(f.file)).toBe(false);
      expect(() => f.store.assertAdmission(f.binding)).toThrow();
    }
    try {
      expect(filesystem.lstatSync(retained, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino });
    } finally { renameSync(retained, f.file); }
  });

  it("refuses symlink authorities and never recreates a missing already initialized authority", () => {
    const f = fixture(); close(f.store);
    const linked = path.join(f.directory, "linked.sqlite"); symlinkSync(f.file, linked);
    expect(() => open(linked)).toThrow("regular physical file");
    rmSync(linked); renameSync(f.file, f.file + ".retained");
    expect(() => open(f.file)).toThrow();
  });

  it("bounds SQLite lock contention without changing the original disable operation", () => {
    const f = enabled(), holder = new Database(f.file); databases.add(holder);
    holder.exec("BEGIN IMMEDIATE");
    try { expect(() => f.store.closeAdmission({ operationId: id(20), local: true })).toThrow(); }
    finally { holder.exec("ROLLBACK"); }
    expect(f.store.readOperation(id(20))).toBeNull();
    expect(f.store.readState()).toMatchObject({ admission: "open", localEpoch: "1" });
  });
});
