import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import { readWindowsBootIdentity } from "../../../src/platform/windows-boot.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore, readCurrentControllerSnapshot, readProvenWindowsStoppedControllerGeneration, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import { recoverControllerAfterWindowsReboot } from "../../../src/commands/controller/reboot-recovery.js";
import { proveWindowsReboot, type WindowsRebootProof } from "../../../src/commands/controller/reboot-proof.js";
import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";

vi.mock("../../../src/platform/windows-boot.js", () => ({ readWindowsBootIdentity: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!, roots: string[] = [];
const identity = { machineHash: "a".repeat(64), bootId: "b".repeat(32) };
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(readWindowsBootIdentity).mockReset(); Object.defineProperty(process, "platform", platform); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.mocked(readWindowsBootIdentity).mockResolvedValue(identity);
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/reboot-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: randomBytes(32).toString("hex"), createdAt: new Date().toISOString() };
  const file = path.join(home, "journal.sqlite"), nativeSessionId = randomUUID();
  const store = openControllerLifecycleStore(file, ticket);
  store.prepareOperation({ operationId: ticket.initialOperationId, kind: "initial", payload: { text: ticket.initialPrompt } });
  store.markDispatching(ticket.initialOperationId);
  store.recordOperation(ticket.initialOperationId, "confirmed");
  store.patchSnapshot({ lifecycle: "working", activity: "working", nativeSessionId, controllerProcess: { pid: 987654, parentPid: 1, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${ticket.launchId}` } });
  store.appendEvent({ text: "retained original output" }); store.close();
  const checkpoint = path.join(home, `reboot-recovery-${ticket.launchId}.json`);
  const beforeWrite = vi.fn(async () => {});
  const run = (prepare: boolean) => recoverControllerAfterWindowsReboot({ file, ticket, prepare, deadline: Date.now() + 10_000, beforeWrite });
  const saved = () => readCurrentControllerSnapshot(file, ticket);
  const change = (patch: Record<string, unknown>) => {
    const db = new Database(file); try { db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...saved(), ...patch })); } finally { db.close(); }
  };
  return { file, ticket, nativeSessionId, checkpoint, beforeWrite, run, saved, change };
};

test("a prepared reboot confirms the exact old generation without losing original input or outbox", async () => {
  const f = await fixture(), original = f.saved();
  expect(await f.run(true)).toBe("prepared");
  expect(f.saved()).toEqual(original);
  expect(readFileSync(f.checkpoint, "utf8")).not.toContain(f.ticket.ipcSecret);
  expect(await f.run(true)).toBe("prepared");
  await expect(f.run(false)).rejects.toThrow("full Windows restart");
  expect(f.saved()).toEqual(original);
  vi.mocked(readWindowsBootIdentity).mockResolvedValue({ ...identity, bootId: "c".repeat(32) });
  expect(await f.run(false)).toBe("stopped");
  const stopped = readProvenWindowsStoppedControllerGeneration(f.file, f.ticket);
  expect(stopped).toMatchObject({ nativeSessionId: f.nativeSessionId, nativeStopped: true, lifecycle: "stopped", initialInputState: "confirmed", sessionId: f.ticket.sessionId, executionGeneration: "1" });
  expect(await f.run(false)).toBe("stopped"); expect(f.saved().stoppedAt).toBe(stopped.stoppedAt);
  const resumed = { ...f.ticket, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: "2", resumeNativeSessionId: f.nativeSessionId };
  const store = openControllerLifecycleStore(f.file, resumed);
  try {
    expect(store.getSnapshot()).toMatchObject({ sessionId: f.ticket.sessionId, nativeSessionId: f.nativeSessionId, initialInputState: "confirmed" });
    expect(store.getOperation(f.ticket.initialOperationId)).toMatchObject({ state: "confirmed" });
    expect(() => store.markDispatching(f.ticket.initialOperationId)).toThrow(/replay/);
    expect(store.pendingEvents()).toMatchObject([{ payload: { text: "retained original output" } }]);
  } finally { store.close(); }
});

test.each(["missing", "malformed", "installation", "snapshot", "query", "same-boot"])("retains the original generation when reboot evidence is %s", async kind => {
  const f = await fixture();
  if (kind !== "missing") await f.run(true);
  const original = f.saved();
  if (kind === "malformed") writeFileSync(f.checkpoint, JSON.stringify({ version: 1, bootId: "invented" }));
  if (kind === "snapshot") f.change({ error: "changed original" });
  const before = f.saved();
  vi.mocked(readWindowsBootIdentity).mockResolvedValue({ ...identity, bootId: kind === "same-boot" ? identity.bootId : "c".repeat(32), machineHash: kind === "installation" ? "d".repeat(64) : identity.machineHash });
  if (kind === "query") vi.mocked(readWindowsBootIdentity).mockRejectedValue(new Error("boot query denied"));
  await expect(f.run(false)).rejects.toThrow();
  expect(f.saved()).toEqual(before); expect(f.saved().nativeStopped).toBe(false); expect(original.windowsJobStopProof).toBeUndefined();
  const permit = acquireControllerStoragePermit(f.file); permit.release();
});

test("changed input, an active writer and a conflicting checkpoint cannot be prepared", async () => {
  const f = await fixture();
  f.change({ initialInputState: "dispatching" });
  await expect(f.run(true)).rejects.toThrow("confirmed initial input");
  expect(existsSync(f.checkpoint)).toBe(false);
  f.change({ initialInputState: "confirmed" });
  const permit = acquireControllerStoragePermit(f.file);
  try { await expect(f.run(true)).rejects.toThrow(/lock|running|held/i); } finally { permit.release(); }
  await f.run(true);
  const originalCheckpoint = readFileSync(f.checkpoint, "utf8");
  vi.mocked(readWindowsBootIdentity).mockResolvedValue({ ...identity, bootId: "c".repeat(32) });
  await expect(f.run(true)).rejects.toThrow("do not overwrite");
  expect(readFileSync(f.checkpoint, "utf8")).toBe(originalCheckpoint);
});

test("a prewrite generation change or changed ticket cannot consume reboot proof", async () => {
  const f = await fixture(); await f.run(true);
  await expect(recordStoppedControllerGeneration(f.file, f.ticket, { rebootProof: {} as WindowsRebootProof })).rejects.toThrow("does not identify");
  expect(f.saved().nativeStopped).toBe(false);
  vi.mocked(readWindowsBootIdentity).mockResolvedValue({ ...identity, bootId: "c".repeat(32) });
  f.beforeWrite.mockImplementationOnce(async () => { f.change({ error: "late writer" }); });
  await expect(f.run(false)).rejects.toThrow("original controller snapshot");
  expect(f.saved().nativeStopped).toBe(false);
  const snapshot = f.saved(), witness = { version: 1 as const, ...identity, ticketHash: controllerPayloadHash(f.ticket), snapshotHash: controllerPayloadHash(snapshot) };
  await expect(proveWindowsReboot(witness, controllerPayloadHash({ ...f.ticket, initialPrompt: "changed" }), witness.snapshotHash, Date.now() + 10_000)).rejects.toThrow("conflicts");
  const proof = await proveWindowsReboot(witness, witness.ticketHash, witness.snapshotHash, Date.now() + 10_000);
  vi.mocked(readWindowsBootIdentity).mockResolvedValue(identity);
  await expect(recordStoppedControllerGeneration(f.file, f.ticket, { rebootProof: proof })).rejects.toThrow("boot identity changed");
  expect(f.saved()).toEqual(snapshot);
});
