import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import * as instanceLock from "../../../src/platform/instance-lock.js";
import { controllerExecutionDirectory } from "../../../src/commands/controller/launch-ticket.js";
import { deleteWebRecording, WebRecordingDiscardedError, withWebRecordingSource } from "../../../src/commands/worker/web-recording-source.js";
import { createWebStoreFixtures } from "./web-store.fixtures.js";
import { createWebArchiveMaintenance } from "../../../src/commands/worker/web-archive-backfill.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";

const { fixture, id, open, close } = createWebStoreFixtures("file");

it("keeps an admitted source operation until exit, rejects new reads, then deletes the entire recording", async () => {
  const { root, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  const task = store.initializeWebExecution(claim, 2);
  store.beginCleanup(claim, { kind: "terminal", deadline: 100 }, 3);
  store.completeTask(claim, 4);
  const directory = controllerExecutionDirectory(root, task.webExecution!.executionId);
  await mkdir(path.join(directory, "media"), { recursive: true });
  const journal = new Database(path.join(directory, "journal.sqlite"));
  journal.pragma("journal_mode = WAL");
  journal.exec("CREATE TABLE recording(value TEXT); INSERT INTO recording VALUES('retained journal')");
  await writeFile(path.join(directory, "media", "frame"), "retained frame");
  let release!: () => void, entered!: () => void, blocked!: () => void;
  const active = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const attempted = new Promise<void>(resolve => { blocked = resolve; });
  const original = instanceLock.acquireInstanceLockSync;
  let count = 0;
  vi.spyOn(instanceLock, "acquireInstanceLockSync").mockImplementation((...args) => { if (++count === 2) blocked(); return original(...args); });
  const reading = withWebRecordingSource(root, task, () => store.getTask(task), async () => { entered(); await gate; const result = await readFile(path.join(directory, "media", "frame"), "utf8"); journal.close(); return result; });
  await active;
  const marked = store.discardRecording(task, 5);
  const deleting = deleteWebRecording(root, marked, () => store.getTask(task), () => true);
  await attempted;
  await expect(withWebRecordingSource(root, task, () => store.getTask(task), async () => "unreachable")).rejects.toBeInstanceOf(WebRecordingDiscardedError);
  expect((await stat(path.join(directory, "journal.sqlite-wal"))).size).toBeGreaterThan(0);
  expect(journal.prepare("SELECT value FROM recording").get()).toEqual({ value: "retained journal" });
  release();
  expect(await reading).toBe("retained frame");
  await deleting;
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(store.getTask(task)?.cleanup?.discardRecording).toBe(true);
});

it("keeps an already selected historical deletion after re-enabling archival", async () => {
  const { root, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  const task = store.initializeWebExecution(claim, 2);
  store.beginCleanup(claim, { kind: "terminal", deadline: 100 }, 3);
  store.completeTask(claim, 4);
  const directory = controllerExecutionDirectory(root, task.webExecution!.executionId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "journal.sqlite"), "recording");
  const worker = openWorkerStore(path.join(root, "worker.sqlite"));
  const signal = new AbortController();
  const archive = vi.fn(async () => {}), probeArchive = vi.fn(async () => ({ kind: "attempt" as const }));
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, signal: signal.signal, store: worker, webStore: store, archive, probeArchive, emit: () => {} });
  let completed!: () => void;
  const deleted = new Promise<void>(resolve => { completed = resolve; });
  const original = worker.deleteArchiveBackfillSchedule;
  vi.spyOn(worker, "deleteArchiveBackfillSchedule").mockImplementation(identity => { original(identity); completed(); });
  try {
    await maintenance.discardLocal(() => true, null, signal.signal);
    expect(store.getTask(task)?.cleanup?.discardRecording).toBe(false);
    await maintenance.discardLocal(() => false, false, signal.signal);
    expect(store.getTask(task)?.cleanup?.discardRecording).toBe(true);
    expect(await readFile(path.join(directory, "journal.sqlite"), "utf8")).toBe("recording");
    await maintenance.discardLocal(() => true, true, signal.signal);
    await deleted;
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(archive).not.toHaveBeenCalled();
    expect(probeArchive).not.toHaveBeenCalled();
  } finally { await maintenance.close(); worker.close(); }
});

it.each([false, null])("rechecks the effective switch (%s) after a backfill waits for its source lock", async selected => {
  const { root, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  store.initializeWebExecution(claim, 2);
  const task = store.updateWebExecution(claim, { sessionId: id(7), launchSubmission: "acknowledged" }, 3);
  store.beginCleanup(claim, { kind: "terminal", deadline: 100 }, 4);
  store.completeTask(claim, 5);
  const worker = openWorkerStore(path.join(root, "worker.sqlite"));
  const signal = new AbortController();
  let release!: () => void, entered!: () => void, blocked!: () => void, observed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const active = new Promise<void>(resolve => { entered = resolve; });
  const attempted = new Promise<void>(resolve => { blocked = resolve; });
  const evaluated = new Promise<void>(resolve => { observed = resolve; });
  const original = instanceLock.acquireInstanceLockSync;
  let count = 0, enabled: boolean | null = true;
  vi.spyOn(instanceLock, "acquireInstanceLockSync").mockImplementation((...args) => { if (++count === 2) blocked(); return original(...args); });
  const archive = vi.fn(async () => {}), probeArchive = vi.fn(async () => ({ kind: "attempt" as const }));
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, signal: signal.signal, store: worker, webStore: store, archive, probeArchive, archiveSessions: () => { observed(); return enabled; }, emit: () => {} });
  try {
    const reading = withWebRecordingSource(root, task, () => store.getTask(task), async () => { entered(); await gate; });
    await active;
    maintenance.request(() => false);
    await attempted;
    enabled = selected;
    release();
    await reading;
    await evaluated;
    expect(probeArchive).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  } finally { release(); await maintenance.close(); worker.close(); }
});

it("does not let a locked recording starve another selected deletion", async () => {
  const { root, store, project, claim } = fixture();
  const other = { ...claim, taskId: id(20), claimId: id(21), worktreeId: id(22) };
  const prepare = (owner: typeof claim) => {
    store.register({ ...owner, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
    const task = store.initializeWebExecution(owner, 2);
    store.beginCleanup(owner, { kind: "terminal", deadline: 100 }, 3);
    store.completeTask(owner, 4);
    return task;
  };
  const first = prepare(claim), second = prepare(other);
  const firstDir = controllerExecutionDirectory(root, first.webExecution!.executionId);
  const secondDir = controllerExecutionDirectory(root, second.webExecution!.executionId);
  await mkdir(firstDir, { recursive: true }); await mkdir(secondDir, { recursive: true });
  await writeFile(path.join(firstDir, "journal.sqlite"), "first");
  await writeFile(path.join(secondDir, "journal.sqlite"), "second");
  const worker = openWorkerStore(path.join(root, "worker.sqlite"));
  const signal = new AbortController();
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, signal: signal.signal, store: worker, webStore: store, archive: async () => {}, probeArchive: async () => ({ kind: "attempt" }), emit: () => {} });
  let release!: () => void, entered!: () => void, blocked!: () => void, firstDone!: () => void, secondDone!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const active = new Promise<void>(resolve => { entered = resolve; });
  const attempted = new Promise<void>(resolve => { blocked = resolve; });
  const firstDeleted = new Promise<void>(resolve => { firstDone = resolve; });
  const secondDeleted = new Promise<void>(resolve => { secondDone = resolve; });
  const originalDelete = worker.deleteArchiveBackfillSchedule;
  vi.spyOn(worker, "deleteArchiveBackfillSchedule").mockImplementation(identity => { originalDelete(identity); if (identity.executionId === first.webExecution!.executionId) firstDone(); else if (identity.executionId === second.webExecution!.executionId) secondDone(); });
  try {
    const reading = withWebRecordingSource(root, first, () => store.getTask(first), async () => { entered(); await gate; });
    await active;
    store.discardRecording(first, 5); store.discardRecording(second, 5);
    const originalLock = instanceLock.acquireInstanceLockSync;
    vi.spyOn(instanceLock, "acquireInstanceLockSync").mockImplementation((...args) => { if (args[0].includes(first.webExecution!.executionId)) blocked(); return originalLock(...args); });
    await maintenance.discardLocal(() => true, true, signal.signal);
    await attempted;
    await secondDeleted;
    expect(await readFile(path.join(firstDir, "journal.sqlite"), "utf8")).toBe("first");
    await expect(stat(secondDir)).rejects.toMatchObject({ code: "ENOENT" });
    release();
    await reading;
    await firstDeleted;
    await expect(stat(firstDir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { release(); await maintenance.close(); worker.close(); }
});

it("retains the original deletion error and retries after backoff without blocking other sources", async () => {
  const { root, store, project, claim } = fixture();
  const other = { ...claim, taskId: id(20), claimId: id(21), worktreeId: id(22) };
  const prepare = (owner: typeof claim) => {
    store.register({ ...owner, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
    const task = store.initializeWebExecution(owner, 2);
    store.beginCleanup(owner, { kind: "terminal", deadline: 100 }, 3); store.completeTask(owner, 4);
    return store.discardRecording(task, 5);
  };
  const first = prepare(claim), second = prepare(other);
  const firstDir = controllerExecutionDirectory(root, first.webExecution!.executionId);
  const secondDir = controllerExecutionDirectory(root, second.webExecution!.executionId);
  await mkdir(firstDir, { recursive: true }); await mkdir(secondDir, { recursive: true });
  await writeFile(path.join(firstDir, "journal.sqlite"), "first"); await writeFile(path.join(secondDir, "journal.sqlite"), "second");
  const worker = openWorkerStore(path.join(root, "worker.sqlite")), signal = new AbortController();
  const failure = Object.assign(new Error("recording access denied"), { code: "EACCES" });
  let failed!: () => void, secondDone!: () => void, firstDone!: () => void;
  const failureObserved = new Promise<void>(resolve => { failed = resolve; });
  const secondDeleted = new Promise<void>(resolve => { secondDone = resolve; });
  const firstDeleted = new Promise<void>(resolve => { firstDone = resolve; });
  const emit = vi.fn((event: { error?: unknown }) => { if (event.error === failure) failed(); });
  const originalDelete = worker.deleteArchiveBackfillSchedule;
  let fail = true, now = Date.now();
  const removeRecording: typeof deleteWebRecording = async (...args) => { if (args[1].claimId === first.claimId && fail) { fail = false; throw failure; } return deleteWebRecording(...args); };
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, signal: signal.signal, store: worker, webStore: store, archive: async () => {}, probeArchive: async () => ({ kind: "attempt" }), emit, removeRecording });
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(worker, "deleteArchiveBackfillSchedule").mockImplementation(identity => { originalDelete(identity); if (identity.executionId === first.webExecution!.executionId) firstDone(); else if (identity.executionId === second.webExecution!.executionId) secondDone(); });
  try {
    await maintenance.discardLocal(() => true, true, signal.signal);
    await Promise.all([failureObserved, secondDeleted]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ error: failure }));
    expect(await readFile(path.join(firstDir, "journal.sqlite"), "utf8")).toBe("first");
    await expect(stat(secondDir)).rejects.toMatchObject({ code: "ENOENT" });
    now += 60_001;
    await maintenance.discardLocal(() => true, true, signal.signal);
    await firstDeleted;
    await expect(stat(firstDir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await maintenance.close(); worker.close(); }
});

it("keeps another Worker's recordings outside archive and deletion maintenance", async () => {
  const { root, store, project, claim } = fixture();
  const foreign = { ...claim, taskId: id(20), claimId: id(21), worktreeId: id(22), workerId: id(23) };
  const prepare = (owner: typeof claim) => {
    store.register({ ...owner, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
    store.initializeWebExecution(owner, 2);
    const task = store.updateWebExecution(owner, { sessionId: id(7), launchSubmission: "acknowledged" }, 3);
    store.beginCleanup(owner, { kind: "terminal", deadline: 100 }, 4); store.completeTask(owner, 5);
    return task;
  };
  const other = prepare(foreign), own = prepare(claim);
  const directory = controllerExecutionDirectory(root, other.webExecution!.executionId);
  await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "journal.sqlite"), "foreign recording");
  const worker = openWorkerStore(path.join(root, "worker.sqlite")), signal = new AbortController();
  let uploaded!: () => void;
  const uploadCalled = new Promise<void>(resolve => { uploaded = resolve; });
  const archive = vi.fn(async () => { uploaded(); });
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, signal: signal.signal, store: worker, webStore: store, archive, probeArchive: async () => ({ kind: "attempt" }), emit: () => {} });
  try {
    maintenance.request(() => false);
    await uploadCalled;
    expect(archive).toHaveBeenCalledOnce();
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({ claimId: own.claimId, workerId: claim.workerId }), expect.any(String), expect.any(AbortSignal));
    await maintenance.discardLocal(() => false, false, signal.signal);
    expect(store.getTask(own)?.cleanup?.discardRecording).toBe(true);
    expect(store.getTask(other)?.cleanup?.discardRecording).toBe(false);
    expect(await readFile(path.join(directory, "journal.sqlite"), "utf8")).toBe("foreign recording");
  } finally { await maintenance.close(); worker.close(); }
});

it("does not hide an I/O failure when shutdown begins during deletion", async () => {
  const { root, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  const task = store.initializeWebExecution(claim, 2);
  store.beginCleanup(claim, { kind: "terminal", deadline: 100 }, 3); store.completeTask(claim, 4); store.discardRecording(task, 5);
  const worker = openWorkerStore(path.join(root, "worker.sqlite")), signal = new AbortController();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const active = new Promise<void>(resolve => { entered = resolve; });
  const failure = Object.assign(new Error("filesystem failure"), { code: "EACCES" });
  const emit = vi.fn();
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, signal: signal.signal, store: worker, webStore: store, archive: async () => {}, probeArchive: async () => ({ kind: "attempt" }), emit, removeRecording: async () => { entered(); await gate; throw failure; } });
  try {
    await maintenance.discardLocal(() => true, true, signal.signal);
    await active;
    const closing = maintenance.close();
    release();
    await expect(closing).rejects.toBe(failure);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ error: failure }));
  } finally { release(); worker.close(); }
});

it("resumes a partially failed recording deletion from its persistent marker after restart", async () => {
  const { root, file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  const task = store.initializeWebExecution(claim, 2);
  store.beginCleanup(claim, { kind: "terminal", deadline: 100 }, 3); store.completeTask(claim, 4); store.discardRecording(task, 5);
  const directory = controllerExecutionDirectory(root, task.webExecution!.executionId);
  await mkdir(path.join(directory, "media"), { recursive: true });
  await writeFile(path.join(directory, "journal.sqlite"), "journal"); await writeFile(path.join(directory, "media", "frame"), "frame");
  const workerFile = path.join(root, "worker.sqlite"), signal = new AbortController();
  const firstWorker = openWorkerStore(workerFile), failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  let observed!: () => void;
  const failed = new Promise<void>(resolve => { observed = resolve; });
  const first = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, signal: signal.signal, store: firstWorker, webStore: store, archive: async () => {}, probeArchive: async () => ({ kind: "attempt" }), emit: event => { if (event.error === failure) observed(); }, removeRecording: async () => { await rm(path.join(directory, "media"), { recursive: true }); throw failure; } });
  await first.discardLocal(() => true, true, signal.signal);
  await failed;
  await first.close(); firstWorker.close(); close(store);
  expect(await readFile(path.join(directory, "journal.sqlite"), "utf8")).toBe("journal");
  await expect(stat(path.join(directory, "media"))).rejects.toMatchObject({ code: "ENOENT" });
  const reopened = open(file), secondWorker = openWorkerStore(workerFile);
  let completed!: () => void;
  const deleted = new Promise<void>(resolve => { completed = resolve; });
  const original = secondWorker.deleteArchiveBackfillSchedule;
  vi.spyOn(secondWorker, "deleteArchiveBackfillSchedule").mockImplementation(identity => { original(identity); completed(); });
  const second = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, signal: signal.signal, store: secondWorker, webStore: reopened, archive: async () => {}, probeArchive: async () => ({ kind: "attempt" }), emit: () => {} });
  try {
    expect(reopened.getTask(task)?.cleanup?.discardRecording).toBe(true);
    await second.discardLocal(() => true, true, signal.signal);
    await deleted;
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await second.close(); secondWorker.close(); }
});

it("waits for one selected recording only and preserves a deletion failure", async () => {
  const { root, store, project, claim } = fixture();
  const other = { ...claim, taskId: id(20), claimId: id(21), worktreeId: id(22) };
  const prepare = (owner: typeof claim) => {
    store.register({ ...owner, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
    const task = store.initializeWebExecution(owner, 2);
    store.beginCleanup(owner, { kind: "terminal", deadline: 100 }, 3); store.completeTask(owner, 4);
    return store.discardRecording(task, 5);
  };
  const task = prepare(claim), sibling = prepare(other);
  const directory = controllerExecutionDirectory(root, task.webExecution!.executionId), siblingDir = controllerExecutionDirectory(root, sibling.webExecution!.executionId);
  await mkdir(directory, { recursive: true }); await mkdir(siblingDir, { recursive: true });
  await writeFile(path.join(directory, "journal.sqlite"), "journal"); await writeFile(path.join(siblingDir, "journal.sqlite"), "sibling");
  const worker = openWorkerStore(path.join(root, "worker.sqlite")), signal = new AbortController();
  const failure = Object.assign(new Error("filesystem failure"), { code: "EACCES" });
  let blocked = true;
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, signal: signal.signal, store: worker, webStore: store, archive: async () => {}, probeArchive: async () => ({ kind: "attempt" }), emit: () => {}, removeRecording: async (...args) => { if (blocked) { blocked = false; throw failure; } return deleteWebRecording(...args); } });
  try {
    await expect(maintenance.discardOne(task, () => true, signal.signal)).rejects.toBe(failure);
    expect(await readFile(path.join(directory, "journal.sqlite"), "utf8")).toBe("journal");
    await maintenance.discardOne(task, () => true, signal.signal);
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(siblingDir, "journal.sqlite"), "utf8")).toBe("sibling");
    const cancelled = new AbortController(); const reason = new Error("cancelled"); cancelled.abort(reason);
    await expect(maintenance.discardOne(sibling, () => true, cancelled.signal)).rejects.toBe(reason);
  } finally { await maintenance.close(); worker.close(); }
});
