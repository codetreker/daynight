import { sqliteDisplayFilename } from "../../../src/platform/sqlite-filename.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import * as instanceLock from "../../../src/platform/instance-lock.js";
import * as sqliteAccess from "../../../src/platform/sqlite-access.js";
import * as durableJson from "../../../src/platform/durable-json.js";
import * as ownedDirectory from "../../../src/commands/worker/owned-source-directory.js";
import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import { probeStoppedControllerArchive } from "../../../src/commands/controller/archive-upload.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { controllerExecutionDirectory, controllerPayloadHash, controllerTicketPath, writeLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { resolveControllerIpcEndpoint } from "../../../src/commands/controller/paths.js";
import { writeUnreleasedLaunch } from "../../../src/commands/controller/unreleased-launch.js";
import * as localClient from "../../../src/commands/controller/local-client.js";
import { replayStoppedControllerUsage } from "../../../src/commands/controller/usage/stopped.js";
import { usageBodyHash } from "../../../src/commands/controller/usage/store.js";
import { mapClaudeUsageEvent } from "../../../src/commands/controller/providers/claude-usage.js";
import { deleteWebRecording, WebRecordingDiscardedError, WebUnreleasedPrecedingJournalError, withWebRecordingSource, withWebUsageSource } from "../../../src/commands/worker/web-recording-source.js";
import { createWebStoreFixtures } from "./web-store.fixtures.js";
import { createWebArchiveMaintenance } from "../../../src/commands/worker/web-archive-backfill.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";

const { fixture, id, open, close } = createWebStoreFixtures("file");

const unreleasedFixture = async (preceding: boolean, savedPid = 12345) => {
  const f = fixture(), { root, store, project, claim } = f;
  const configuration = { agent: "claude" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  store.register({ ...claim, project, configuration, userId: id(6) }, 1);
  let task = store.initializeWebExecution(claim, 2);
  const execution = task.webExecution!, nativeSessionId = id(8);
  task = store.updateWebExecution(claim, { sessionId: id(7), initialPrompt: "managed" }, 3);
  const original: ControllerLaunchTicket = { schemaVersion: 1, launchId: execution.launchId, executionId: execution.executionId,
    controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, sessionId: id(7), executionGeneration: "1",
    serverOrigin: claim.serverOrigin, projectId: claim.projectId, taskId: claim.taskId, claimId: claim.claimId, workerId: claim.workerId,
    worktreeId: claim.worktreeId, userId: id(6), provider: "claude", cwd: root, nativeHome: path.join(root, "native"), configuration,
    initialOperationId: execution.initialOperationId, initialPrompt: "managed", resumeNativeSessionId: null,
    credentialFile: path.join(root, "credential.json"), ipcEndpoint: resolveControllerIpcEndpoint(root, execution.launchId), ipcSecret: "a".repeat(64), createdAt: new Date(0).toISOString() };
  let ticket = original;
  let usageState: ReturnType<ReturnType<typeof openControllerLifecycleStore>["usage"]["ensureState"]> | undefined;
  const directory = controllerExecutionDirectory(root, execution.executionId), journalPath = path.join(directory, "journal.sqlite");
  if (preceding) {
    const proof = { pid: 987, parentPid: 1, processGroupId: process.platform === "win32" ? null : 987, startedAt: "original", commandHash: "b".repeat(64),
      ...(process.platform === "win32" ? { jobObjectName: `Local\\Daynight-${original.launchId}` } : {}) };
    await mkdir(directory, { recursive: true });
    const journal = openControllerLifecycleStore(journalPath, original);
    usageState = journal.usage.ensureState("1", nativeSessionId, "0.3.247/2.1.247/anthropic", "claude");
    journal.usage.saveGrant(usageState.stateId, { token: "g".repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, "1");
    journal.usage.enqueueMeasurement(usageState.stateId, mapClaudeUsageEvent({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_stopped", stop_reason: "end_turn", model: "claude-test", usage: { input_tokens: 17, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })!);
    journal.patchSnapshot({ controllerProcess: proof, nativeProcesses: [], nativeSessionId, lifecycle: "stopped", activity: "stopped",
      initialInputState: "confirmed", nativeStopped: true, stoppedAt: new Date(0).toISOString() });
    let snapshot = journal.getSnapshot(); journal.close();
    if (process.platform === "win32") snapshot = { ...snapshot, windowsJobStopProof: { version: 1, ticketHash: controllerPayloadHash(original), snapshotHash: controllerPayloadHash(snapshot) } };
    await writeLaunchTicket(root, original);
    const db = new Database(journalPath); db.prepare("UPDATE execution SET owner_pid=NULL,snapshot=? WHERE id=1").run(JSON.stringify(snapshot)); db.close();
    task = store.updateWebExecution(task, { controllerProcess: proof, launchSubmission: "acknowledged", initialInputState: "confirmed" }, 4);
    task = store.bindNativeSession(task, { source: "controller", sessionId: nativeSessionId }, 5);
    task = store.beginWebGeneration(task, snapshot, 6);
    ticket = { ...original, launchId: task.webExecution!.launchId, controllerInstanceId: task.webExecution!.controllerInstanceId,
      executionGeneration: "2", resumeNativeSessionId: nativeSessionId, ipcEndpoint: resolveControllerIpcEndpoint(root, task.webExecution!.launchId) };
  }
  const ticketPath = await writeLaunchTicket(root, ticket);
  task = store.updateWebExecution(task, { ticketPath, launchSubmission: "unknown", controllerProcess: { kind: "linux-controller-launch", pid: savedPid, launchId: ticket.launchId } }, 7);
  await writeUnreleasedLaunch(root, ticket, 12345);
  store.beginCleanup(task, { kind: "terminal", deadline: 100 }, 8);
  task = store.completeTask(task, 9);
  return { ...f, task, ticket, original, usageState, directory, journalPath };
};

it("keeps a completed unreleased generation's preceding journal and usage fenced across maintenance restarts", async () => {
  const f = await unreleasedFixture(true), worker = openWorkerStore(path.join(f.root, "worker.sqlite"));
  const signal = new AbortController(), events: { kind: string; error?: unknown }[] = [];
  const archive = vi.fn(async () => {}), probeArchive = vi.fn(async () => ({ kind: "attempt" as const }));
  const usage = vi.fn(async (_task: typeof f.task, _journal: string, _signal: AbortSignal, preceding?: ControllerLaunchTicket) => {
    expect(preceding).toEqual(f.original);
    return { pending: 0 };
  });
  const make = () => createWebArchiveMaintenance({ homeDirectory: f.root, serverUrl: f.claim.serverOrigin, workerId: f.claim.workerId,
    userId: id(6), signal: signal.signal, store: worker, webStore: f.store, archive, probeArchive, usage, emit: event => events.push(event) });
  const before = await readFile(f.journalPath);
  let maintenance = make();
  try {
    await expect(withWebRecordingSource(f.root, f.task, () => f.store.getTask(f.task), async () => {})).rejects.toBeInstanceOf(WebUnreleasedPrecedingJournalError);
    for (let attempt = 1; attempt <= 2; attempt++) {
      let turns = 0;
      maintenance.request(() => { turns++; return false; });
      await vi.waitFor(() => expect(events.map(event => ({ kind: event.kind, error: String(event.error) }))).toEqual(Array.from({ length: attempt }, () => ({ kind: "session-archive-blocked", error: expect.stringContaining("current Controller launch was unreleased") }))));
      await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(attempt));
      await vi.waitFor(() => expect(turns).toBeGreaterThanOrEqual(2));
      maintenance.request(() => { turns++; return false; });
      await vi.waitFor(() => expect(turns).toBeGreaterThanOrEqual(4));
      expect(events).toHaveLength(attempt);
      await maintenance.close();
      if (attempt === 1) maintenance = make();
    }
    expect(archive).not.toHaveBeenCalled(); expect(probeArchive).not.toHaveBeenCalled(); expect(usage).toHaveBeenCalledTimes(2);
    expect(events.every(event => event.error instanceof WebUnreleasedPrecedingJournalError)).toBe(true);
    expect(await readFile(f.journalPath)).toEqual(before);
    expect(f.store.getTask(f.task)).toMatchObject({ resources: { nativeSession: { sessionId: id(8) } }, webExecution: { executionGeneration: "2", launchId: f.ticket.launchId } });
    const discarded = f.store.discardRecording(f.task, 10);
    await expect(deleteWebRecording(f.root, discarded, () => f.store.getTask(discarded), () => true)).rejects.toThrow(/pending or quarantined usage/);
    maintenance = make();
    await expect(maintenance.discardOne(discarded, () => true, signal.signal)).rejects.toThrow(/pending or quarantined usage/);
    expect(await readFile(f.journalPath)).toEqual(before);
  } finally { await maintenance.close(); worker.close(); }
}, 15_000);

it("does not start archive or usage for an unreleased first generation without a journal", async () => {
  const f = await unreleasedFixture(false), archive = vi.fn(), usage = vi.fn();
  await expect(withWebRecordingSource(f.root, f.task, () => f.store.getTask(f.task), archive)).rejects.toThrow(/has no recording or usage source/);
  await expect(withWebUsageSource(f.root, f.task, () => f.store.getTask(f.task), usage)).rejects.toThrow(/has no recording or usage source/);
  expect(archive).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
});

it("replays a predecessor's retained usage grant without authorizing its archive or renewing the grant", async () => {
  const f = await unreleasedFixture(true), worker = openWorkerStore(path.join(f.root, "worker.sqlite")), signal = new AbortController();
  const state = f.usageState!;
  const capability = { profileId: "claude-message-input-0.3.247-v1", qualification: "verified", measurementPlane: "native_event", revisionAuthority: "immutable", metrics: { inputTokens: "unknown", outputTokens: "supported", cacheReadTokens: "unknown", cacheWriteTokens: "unknown", reasoningTokens: "optional", totalTokens: "unknown" }, subagents: "included_per_event", recovery: "durable_after_ingress_only", completion: "partial_only" };
  const paths: string[] = [], posted: Record<string, unknown>[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    if (url.pathname.endsWith("capabilities")) return Response.json({ protocol: "daynight.usage.v1", schemaVersion: 1, writeEnabled: true,
      profiles: [{ id: capability.profileId, provider: "claude", capability, qualifiedVersions: [{ providerVersion: state.providerVersion, capability }] }] });
    expect(url.pathname).toBe(`/api/usage/v1/states/${state.stateId}/batches`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"g".repeat(43)}`);
    const body = JSON.parse(String(init?.body)) as { batchId: string; events: Record<string, unknown>[] }; posted.push(...body.events);
    return Response.json({ protocol: "daynight.usage.v1", batchId: body.batchId, results: body.events.map(payload => ({ eventId: payload.eventId,
      sourceKey: payload.sourceKey ?? null, sourceRevision: payload.sourceRevision ?? null, stateSequence: payload.stateSequence ?? null,
      finality: payload.finality ?? null, outcome: "inserted", rowId: randomUUID(), rowVersion: "1", bodyHash: usageBodyHash(state, payload) })) });
  };
  let finished!: (value: { result?: { pending: number; retryable: boolean }; error?: unknown }) => void;
  const settled = new Promise<{ result?: { pending: number; retryable: boolean }; error?: unknown }>(resolve => { finished = resolve; });
  const usage = vi.fn(async (_task: typeof f.task, journalPath: string, operationSignal: AbortSignal, preceding?: ControllerLaunchTicket) => {
    try {
      expect(preceding).toEqual(f.original);
      const result = await replayStoppedControllerUsage({ journalPath, ticket: preceding!, serverToken: "parent", signal: operationSignal, request });
      finished({ result }); return result;
    } catch (error) { finished({ error }); throw error; }
  });
  const archive = vi.fn(async () => {}), probeArchive = vi.fn(async () => ({ kind: "attempt" as const })), events: { kind: string }[] = [];
  const maintenance = createWebArchiveMaintenance({ homeDirectory: f.root, serverUrl: f.claim.serverOrigin, workerId: f.claim.workerId,
    userId: id(6), signal: signal.signal, store: worker, webStore: f.store, archive, probeArchive, usage, emit: event => events.push(event) });
  const identity = () => { const db = new Database(f.journalPath, { readonly: true }); try { return db.prepare("SELECT snapshot,ticket_hash,owner_pid FROM execution WHERE id=1").get(); } finally { db.close(); } };
  const before = identity();
  try {
    maintenance.request(() => false);
    const outcome = await settled;
    if (outcome.error !== undefined) throw outcome.error;
    expect(outcome.result).toEqual({ pending: 0, retryable: false });
    expect(posted.some(event => event.kind === "measurement")).toBe(true);
    expect(paths.some(value => value.endsWith("registrations") || value.endsWith("grant"))).toBe(false);
    expect(events.some(event => event.kind === "session-archive-blocked")).toBe(true);
    expect(archive).not.toHaveBeenCalled(); expect(probeArchive).not.toHaveBeenCalled();
    expect(identity()).toEqual(before);
    await maintenance.close();
    const discarded = f.store.discardRecording(f.task, 10);
    await deleteWebRecording(f.root, discarded, () => f.store.getTask(discarded), () => true);
    await expect(stat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    const afterRestart = vi.fn();
    await expect(withWebUsageSource(f.root, discarded, () => f.store.getTask(discarded), afterRestart)).rejects.toThrow(/has no recording or usage source/);
    expect(afterRestart).not.toHaveBeenCalled();
    await expect(deleteWebRecording(f.root, discarded, () => f.store.getTask(discarded), () => true)).resolves.toBeUndefined();
  } finally { await maintenance.close(); worker.close(); }
}, 15_000);

it("keeps a missing preceding source unknown without a completed discard receipt", async () => {
  const f = await unreleasedFixture(true), usage = vi.fn();
  await rm(f.directory, { recursive: true });
  await expect(withWebUsageSource(f.root, f.task, () => f.store.getTask(f.task), usage)).rejects.toThrow(/lacks its preceding generation evidence/);
  const discarded = f.store.discardRecording(f.task, 10);
  await expect(deleteWebRecording(f.root, discarded, () => f.store.getTask(discarded), () => true)).rejects.toThrow(/lacks its preceding generation evidence/);
  expect(usage).not.toHaveBeenCalled();
});

it.each(["intent", "completed", "partial"] as const)("recovers or retains a predecessor after a discard publication fault (%s)", async fault => {
  const f = await unreleasedFixture(true), discarded = f.store.discardRecording(f.task, 10);
  const db = new Database(f.journalPath); db.prepare("DELETE FROM usage_outbox").run(); db.close();
  const original = durableJson.writeDurableJson;
  const write = vi.spyOn(durableJson, "writeDurableJson").mockImplementation((file, value) => {
    const state = (value as { state?: string }).state;
    if (state === (fault === "intent" ? "intent" : "completed")) throw new Error("controlled discard receipt failure");
    return original(file, value);
  });
  const receipt = `${controllerTicketPath(f.root, f.ticket.launchId)}.recording-discarded.json`;
  await expect(deleteWebRecording(f.root, discarded, () => f.store.getTask(discarded), () => true)).rejects.toThrow("controlled discard receipt failure");
  write.mockRestore();
  if (fault === "intent") {
    expect((await stat(f.journalPath)).isFile()).toBe(true);
    await expect(stat(receipt)).rejects.toMatchObject({ code: "ENOENT" });
    await deleteWebRecording(f.root, discarded, () => f.store.getTask(discarded), () => true);
  } else {
    expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({ state: "intent", ticketHash: controllerPayloadHash(f.ticket), precedingTicketHash: controllerPayloadHash(f.original) });
    await expect(stat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    if (fault === "partial") {
      await mkdir(f.directory); await writeFile(path.join(f.directory, "retained-partial"), "unknown");
      await expect(deleteWebRecording(f.root, discarded, () => f.store.getTask(discarded), () => true)).rejects.toThrow(/directory identity changed/);
      expect(await readFile(path.join(f.directory, "retained-partial"), "utf8")).toBe("unknown");
      expect(JSON.parse(await readFile(receipt, "utf8")).state).toBe("intent");
      return;
    }
    const usage = vi.fn();
    await expect(withWebUsageSource(f.root, discarded, () => f.store.getTask(discarded), usage)).rejects.toThrow(/has no recording or usage source/);
    expect(usage).not.toHaveBeenCalled();
  }
  expect(JSON.parse(await readFile(receipt, "utf8")).state).toBe("completed");
  await expect(deleteWebRecording(f.root, discarded, () => f.store.getTask(discarded), () => true)).resolves.toBeUndefined();
}, 15_000);

it.each(["original", "replacement"] as const)("resumes only the original partially deleted recording directory (%s)", async kind => {
  const f = await unreleasedFixture(true), discarded = f.store.discardRecording(f.task, 10);
  const db = new Database(f.journalPath); db.prepare("DELETE FROM usage_outbox").run(); db.close();
  const before = await stat(f.directory, { bigint: true });
  const remove = vi.spyOn(ownedDirectory, "removeOwnedSourceDirectory").mockImplementationOnce(async () => {
    await rm(f.journalPath);
    throw new Error("controlled partial removal");
  });
  await expect(deleteWebRecording(f.root, discarded, () => f.store.getTask(discarded), () => true)).rejects.toThrow("controlled partial removal");
  remove.mockRestore();
  const receipt = `${controllerTicketPath(f.root, f.ticket.launchId)}.recording-discarded.json`;
  expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({ state: "intent", sourceIdentity: `${before.dev}:${before.ino}` });
  if (kind === "replacement") {
    await rename(f.directory, `${f.directory}-retained`);
    await mkdir(f.directory); await writeFile(path.join(f.directory, "sentinel"), "replacement");
    await expect(deleteWebRecording(f.root, discarded, () => f.store.getTask(discarded), () => true)).rejects.toThrow(/directory identity changed/);
    expect(await readFile(path.join(f.directory, "sentinel"), "utf8")).toBe("replacement");
    expect(JSON.parse(await readFile(receipt, "utf8")).state).toBe("intent");
  } else {
    await deleteWebRecording(f.root, discarded, () => f.store.getTask(discarded), () => true);
    await expect(stat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(receipt, "utf8")).state).toBe("completed");
  }
}, 15_000);

it("rechecks a blocked discard after the existing backoff and deletes only after usage clears", async () => {
  const f = await unreleasedFixture(true), worker = openWorkerStore(path.join(f.root, "worker.sqlite")), signal = new AbortController();
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  const events: { kind: string }[] = [], removeRecording = vi.fn<typeof deleteWebRecording>(async (...args) => deleteWebRecording(...args));
  const maintenance = createWebArchiveMaintenance({ homeDirectory: f.root, serverUrl: f.claim.serverOrigin, workerId: f.claim.workerId,
    userId: id(6), signal: signal.signal, store: worker, webStore: f.store, archive: async () => {}, probeArchive: async () => ({ kind: "attempt" }),
    removeRecording, emit: event => events.push(event) });
  try {
    maintenance.request(() => false);
    await vi.waitFor(() => expect(events.some(event => event.kind === "session-archive-blocked")).toBe(true));
    await maintenance.discardLocal(() => true, false, signal.signal);
    await vi.waitFor(() => expect(events.some(event => event.kind === "cleanup-error")).toBe(true));
    expect(removeRecording).toHaveBeenCalledOnce();
    await maintenance.discardLocal(() => true, false, signal.signal);
    expect(removeRecording).toHaveBeenCalledOnce();
    const db = new Database(f.journalPath); db.prepare("DELETE FROM usage_outbox").run(); db.close();
    now += 60_001;
    await maintenance.discardLocal(() => true, false, signal.signal);
    await vi.waitFor(async () => { expect(removeRecording).toHaveBeenCalledTimes(2); await expect(stat(f.directory)).rejects.toMatchObject({ code: "ENOENT" }); });
  } finally { await maintenance.close(); worker.close(); }
}, 15_000);

it.each(["missing-ticket", "changed-hash"] as const)("retains predecessor usage when its %s cannot be bound to the stopped journal", async conflict => {
  const f = await unreleasedFixture(true), action = vi.fn();
  if (conflict === "missing-ticket") await rm(controllerTicketPath(f.root, f.original.launchId));
  else { const db = new Database(f.journalPath); db.prepare("UPDATE execution SET ticket_hash=? WHERE id=1").run("f".repeat(64)); db.close(); }
  await expect(withWebUsageSource(f.root, f.task, () => f.store.getTask(f.task), action)).rejects.toThrow();
  expect(action).not.toHaveBeenCalled();
  expect((await stat(f.journalPath)).isFile()).toBe(true);
});

it("retains an unreleased first generation when a journal sidecar has no database", async () => {
  const f = await unreleasedFixture(false), archive = vi.fn();
  await mkdir(f.directory, { recursive: true });
  await writeFile(`${f.journalPath}-wal`, "retained evidence");
  await expect(withWebRecordingSource(f.root, f.task, () => f.store.getTask(f.task), archive)).rejects.toThrow(/sidecar/);
  const discarded = f.store.discardRecording(f.task, 10);
  await expect(deleteWebRecording(f.root, discarded, () => f.store.getTask(discarded), () => true)).rejects.toThrow(/sidecar/);
  expect(await readFile(`${f.journalPath}-wal`, "utf8")).toBe("retained evidence");
  expect(archive).not.toHaveBeenCalled();
});

it("does not let a retained unreleased generation hide a later generation of the same execution", async () => {
  const f = await unreleasedFixture(true), worker = openWorkerStore(path.join(f.root, "worker.sqlite")), signal = new AbortController();
  const events: { kind: string }[] = [], archive = vi.fn(async () => {}), probeArchive = vi.fn(async () => ({ kind: "attempt" as const }));
  const maintenance = createWebArchiveMaintenance({ homeDirectory: f.root, serverUrl: f.claim.serverOrigin, workerId: f.claim.workerId,
    userId: id(6), signal: signal.signal, store: worker, webStore: f.store, archive, probeArchive, emit: event => events.push(event) });
  try {
    maintenance.request(() => false);
    await vi.waitFor(() => expect(events.some(event => event.kind === "session-archive-blocked")).toBe(true));
    const later = { ...f.task, webExecution: { ...f.task.webExecution!, executionGeneration: "3", launchId: randomUUID(), controllerInstanceId: randomUUID(), launchSubmission: "acknowledged" as const } };
    vi.spyOn(f.store, "listCompletedTasks").mockReturnValue([later]);
    vi.spyOn(f.store, "getTask").mockReturnValue(later);
    await vi.waitFor(() => {
      maintenance.request(() => false);
      expect(archive).toHaveBeenCalledOnce();
    });
    expect(archive).toHaveBeenCalledWith(later, f.journalPath, expect.any(AbortSignal));
  } finally { await maintenance.close(); worker.close(); }
}, 15_000);

it.each(["pid", "journal", "ipc"] as const)("reports conflicting unreleased %s evidence without starting background replay", async conflict => {
  const f = await unreleasedFixture(true, conflict === "pid" ? 12346 : 12345), worker = openWorkerStore(path.join(f.root, "worker.sqlite")), signal = new AbortController();
  if (conflict === "journal") {
    const db = new Database(f.journalPath);
    const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string };
    const snapshot = JSON.parse(row.snapshot) as { executionGeneration: string; controllerInstanceId: string };
    snapshot.executionGeneration = "2"; snapshot.controllerInstanceId = f.ticket.controllerInstanceId;
    db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(snapshot)); db.close();
  }
  if (conflict === "ipc") vi.spyOn(localClient, "requestController").mockRejectedValue(new localClient.ControllerIpcOutcomeUnknownError("Controller observation timed out."));
  const archive = vi.fn(async () => {}), probeArchive = vi.fn(async () => ({ kind: "attempt" as const })), usage = vi.fn(async () => ({ pending: 0 }));
  const events: { kind: string; error?: unknown }[] = [];
  const maintenance = createWebArchiveMaintenance({ homeDirectory: f.root, serverUrl: f.claim.serverOrigin, workerId: f.claim.workerId,
    userId: id(6), signal: signal.signal, store: worker, webStore: f.store, archive, probeArchive, usage, emit: event => events.push(event) });
  const before = await readFile(f.journalPath);
  try {
    maintenance.request(() => false);
    await vi.waitFor(() => expect(events.some(event => event.kind === "session-archive-retry" && event.error instanceof Error)).toBe(true));
    await maintenance.close();
    expect(archive).not.toHaveBeenCalled(); expect(probeArchive).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
    expect(await readFile(f.journalPath)).toEqual(before);
  } finally { await maintenance.close(); worker.close(); }
}, 15_000);

it.each(["unsupported", "invalid-schema"] as const)("releases the recording source after a closed journal probe fails: %s", async mode => {
  const { root, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  const task = store.initializeWebExecution(claim, 2);
  store.beginCleanup(claim, { kind: "terminal", deadline: 100 }, 3); store.completeTask(claim, 4);
  const directory = controllerExecutionDirectory(root, task.webExecution!.executionId), journalPath = path.join(directory, "journal.sqlite");
  await mkdir(directory, { recursive: true });
  const journal = new Database(journalPath);
  journal.pragma(`user_version = ${mode === "unsupported" ? currentSqliteVersion(controllerJournalFormat) + 1 : currentSqliteVersion(controllerJournalFormat)}`);
  journal.close();
  const probe = () => probeStoppedControllerArchive({ journalPath, ticket: {} as ControllerLaunchTicket });
  await expect(withWebRecordingSource(root, task, () => store.getTask(task), probe)).rejects.toMatchObject({
    kind: mode === "unsupported" ? "unsupported-version" : "invalid-format", connectionClosed: true,
  });
  const marked = store.discardRecording(task, 5);
  await deleteWebRecording(root, marked, () => store.getTask(task), () => true);
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains the recording source lock while journal closure is unconfirmed", async () => {
  const { root, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  const task = store.initializeWebExecution(claim, 2);
  store.beginCleanup(claim, { kind: "terminal", deadline: 100 }, 3); store.completeTask(claim, 4);
  const directory = controllerExecutionDirectory(root, task.webExecution!.executionId), journalPath = path.join(directory, "journal.sqlite");
  await mkdir(directory, { recursive: true });
  const journal = new Database(journalPath); journal.pragma(`user_version = ${currentSqliteVersion(controllerJournalFormat) + 1}`); journal.close();
  const acquire = instanceLock.acquireInstanceLockSync, closeDatabase = sqliteAccess.closeSqliteDatabase;
  let held: ReturnType<typeof acquire> | undefined, lockFile = "", gateFile = "", unclosed: Database.Database | undefined;
  vi.spyOn(instanceLock, "acquireInstanceLockSync").mockImplementation((...args) => { const lock = acquire(...args); held = lock; [lockFile, gateFile] = args; return lock; });
  const failure = new Error("controlled journal close failure");
  vi.spyOn(sqliteAccess, "closeSqliteDatabase").mockImplementation((db, options, outcome) => {
    if (sqliteDisplayFilename(db.name) === journalPath) { unclosed = db; throw failure; }
    closeDatabase(db, options, outcome);
  });
  try {
    await expect(withWebRecordingSource(root, task, () => store.getTask(task), () => probeStoppedControllerArchive({ journalPath, ticket: {} as ControllerLaunchTicket }))).rejects.toMatchObject({
      kind: "cleanup-failed", connectionClosed: false,
      cause: { errors: [expect.objectContaining({ kind: "unsupported-version" }), failure] },
    });
    expect(unclosed?.open).toBe(true);
    expect(() => acquire(lockFile, gateFile)).toThrow("Cannot acquire instance lock");
  } finally {
    if (unclosed?.open) unclosed.close();
    held?.release();
  }
  const marked = store.discardRecording(task, 5);
  await deleteWebRecording(root, marked, () => store.getTask(task), () => true);
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

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
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, userId: id(6), signal: signal.signal, store: worker, webStore: store, archive, probeArchive, emit: () => {} });
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
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, userId: id(6), signal: signal.signal, store: worker, webStore: store, archive, probeArchive, archiveSessions: () => { observed(); return enabled; }, emit: () => {} });
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
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, userId: id(6), signal: signal.signal, store: worker, webStore: store, archive: async () => {}, probeArchive: async () => ({ kind: "attempt" }), emit: () => {} });
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
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, userId: id(6), signal: signal.signal, store: worker, webStore: store, archive: async () => {}, probeArchive: async () => ({ kind: "attempt" }), emit, removeRecording });
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
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, userId: id(6), signal: signal.signal, store: worker, webStore: store, archive, probeArchive: async () => ({ kind: "attempt" }), emit: () => {} });
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
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, userId: id(6), signal: signal.signal, store: worker, webStore: store, archive: async () => {}, probeArchive: async () => ({ kind: "attempt" }), emit, removeRecording: async () => { entered(); await gate; throw failure; } });
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
  const first = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, userId: id(6), signal: signal.signal, store: firstWorker, webStore: store, archive: async () => {}, probeArchive: async () => ({ kind: "attempt" }), emit: event => { if (event.error === failure) observed(); }, removeRecording: async () => { await rm(path.join(directory, "media"), { recursive: true }); throw failure; } });
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
  const second = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, userId: id(6), signal: signal.signal, store: secondWorker, webStore: reopened, archive: async () => {}, probeArchive: async () => ({ kind: "attempt" }), emit: () => {} });
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
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, userId: id(6), signal: signal.signal, store: worker, webStore: store, archive: async () => {}, probeArchive: async () => ({ kind: "attempt" }), emit: () => {}, removeRecording: async (...args) => { if (blocked) { blocked = false; throw failure; } return deleteWebRecording(...args); } });
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

it("does not archive or discard a completed recording owned by another user", async () => {
  const { root, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  const task = store.initializeWebExecution(claim, 2);
  store.beginCleanup(claim, { kind: "terminal", deadline: 100 }, 3);
  store.completeTask(claim, 4);
  const directory = controllerExecutionDirectory(root, task.webExecution!.executionId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "journal.sqlite"), "original");
  const worker = openWorkerStore(path.join(root, "worker.sqlite"));
  const signal = new AbortController();
  const archive = vi.fn(async () => {}), probeArchive = vi.fn(async () => ({ kind: "attempt" as const }));
  const maintenance = createWebArchiveMaintenance({ homeDirectory: root, serverUrl: claim.serverOrigin, workerId: claim.workerId, userId: id(7), signal: signal.signal, store: worker, webStore: store, archive, probeArchive, emit: () => {} });
  try {
    await maintenance.discardLocal(() => true, false, signal.signal);
    maintenance.request(() => false);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(store.getTask(task)?.cleanup?.discardRecording).toBe(false);
    expect(await readFile(path.join(directory, "journal.sqlite"), "utf8")).toBe("original");
    expect(probeArchive).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    await expect(maintenance.discardOne(store.getTask(task)!, () => true, signal.signal)).rejects.toThrow("identity changed");
    const marked = store.discardRecording(store.getTask(task)!, 5);
    await maintenance.discardOne(marked, () => true, signal.signal, id(6));
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await maintenance.close(); worker.close(); }
});
