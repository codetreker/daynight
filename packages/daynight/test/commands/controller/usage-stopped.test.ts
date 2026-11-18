import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openControllerLifecycleStore, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { controllerExecutionDirectory, writeLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { acquireControllerStoragePermit } from "../../../src/commands/controller/storage-lock.js";
import { countStoppedControllerUsage, replayStoppedControllerUsage } from "../../../src/commands/controller/usage/stopped.js";
import { usageBodyHash } from "../../../src/commands/controller/usage/store.js";
import { deleteWebRecording } from "../../../src/commands/worker/web-recording-source.js";
import type { LocalTask } from "../../../src/commands/worker/backends/web-types.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const capability = { profileId: "copilot-event-1.0.11-v1", qualification: "verified", measurementPlane: "native_event", revisionAuthority: "immutable", metrics: { inputTokens: "unknown", outputTokens: "supported", cacheReadTokens: "unknown", cacheWriteTokens: "unknown", reasoningTokens: "optional", totalTokens: "unknown" }, subagents: "included_per_event", recovery: "durable_after_ingress_only", completion: "partial_only" };
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/usage-stopped-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "copilot", cwd: home, nativeHome: path.join(home, ".copilot"), configuration: { agent: "copilot", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const directory = controllerExecutionDirectory(home, ticket.executionId); await mkdir(directory, { recursive: true });
  const journalPath = path.join(directory, "journal.sqlite"), journal = openControllerLifecycleStore(journalPath, ticket, { contentOwnedLocally: true });
  const state = journal.usage.ensureState("1", randomUUID(), "1.0.11/1.0.105");
  journal.usage.saveGrant(state.stateId, { token: "g".repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, "1");
  journal.usage.enqueueMeasurement(state.stateId, { sourceKey: `copilot-event-v1:${randomUUID()}`, profileId: capability.profileId, revisionAuthority: "immutable", sourceRevision: "1", finality: "final", disposition: "active", aggregationRole: "counted", includedInSourceKey: null, nativeTurnId: null, nativeCallId: null, model: "model", metrics: { inputTokens: null, outputTokens: "17", cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, totalTokens: null, providerTotalTokens: null }, nativeMetrics: { outputTokens: "17" }, reasonCodes: [], observedAt: new Date().toISOString() });
  journal.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "text", text: "original content" }] });
  journal.patchSnapshot({ lifecycle: "stopped", nativeSessionId: state.nativeSessionId, nativeStopped: true, stoppedAt: new Date().toISOString() }); journal.close();
  if (process.platform === "win32") {
    const db = new Database(journalPath);
    try { const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string }; db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...JSON.parse(row.snapshot), lifecycle: "stopping", nativeStopped: false, stoppedAt: null, controllerProcess: { pid: 2_000_000_000, parentPid: 1, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${ticket.launchId}` } })); }
    finally { db.close(); }
    const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
    try { await recordStoppedControllerGeneration(journalPath, ticket, { jobLease: {} as ControllerJobLease }); }
    finally { confirm.mockRestore(); }
  }
  const read = () => { const db = new Database(journalPath, { readonly: true }); try { return { execution: db.prepare("SELECT snapshot,ticket_hash,owner_pid,last_sequence,last_acknowledged FROM execution WHERE id=1").get(), outbox: db.prepare("SELECT * FROM outbox ORDER BY sequence").all(), usage: db.prepare("SELECT payload FROM usage_outbox ORDER BY local_sequence").all() }; } finally { db.close(); } };
  return { home, journalPath, ticket, state, read };
};

test("replays original grants after native stop, seals crash gaps, and never holds storage across HTTP", async () => {
  const f = await fixture(), before = f.read(), paths: string[] = [], events: Record<string, unknown>[] = [];
  const request: typeof fetch = async (input, init) => {
    // A real permit acquisition proves each network operation is outside local storage admission.
    const permit = acquireControllerStoragePermit(f.journalPath, undefined, { fileMustExist: true }); permit.release();
    const url = new URL(String(input)); paths.push(url.pathname);
    if (url.pathname.endsWith("capabilities")) return Response.json({ protocol: "daynight.usage.v1", schemaVersion: 1, writeEnabled: true, profiles: [{ id: capability.profileId, provider: "copilot", capability: { ...capability, qualification: "unverified" }, qualifiedVersions: [{ providerVersion: f.state.providerVersion, capability }] }] });
    expect(url.pathname).toBe(`/api/usage/v1/states/${f.state.stateId}/batches`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"g".repeat(43)}`);
    const body = JSON.parse(String(init?.body)) as { batchId: string; events: Record<string, unknown>[] }; events.push(...body.events);
    return Response.json({ protocol: "daynight.usage.v1", batchId: body.batchId, results: body.events.map(payload => ({ eventId: payload.eventId, sourceKey: payload.sourceKey ?? null, sourceRevision: payload.sourceRevision ?? null, stateSequence: payload.stateSequence ?? null, finality: payload.finality ?? null, outcome: "inserted", rowId: randomUUID(), rowVersion: "1", bodyHash: usageBodyHash(f.state, payload) })) });
  };
  expect(await replayStoppedControllerUsage({ ...f, serverToken: "parent", request })).toEqual({ pending: 0 });
  expect(events.filter(event => event.kind === "measurement")).toHaveLength(1);
  expect(events.find(event => event.kind === "execution_state")).toMatchObject({ collectionState: "partial", seal: true, reasonCodes: ["missing_final", "native_recovery_gap"] });
  expect(paths.some(value => value.endsWith("registrations") || value.endsWith("grant"))).toBe(false);
  const after = f.read(); expect(after.execution).toEqual(before.execution); expect(after.outbox).toEqual(before.outbox); expect(after.usage).toHaveLength(0);
});

test("rejects changed execution identity before network or acknowledgement", async () => {
  const f = await fixture(), request = vi.fn<typeof fetch>();
  await expect(replayStoppedControllerUsage({ ...f, ticket: { ...f.ticket, claimId: randomUUID() }, serverToken: "parent", request })).rejects.toThrow();
  expect(request).not.toHaveBeenCalled(); expect(countStoppedControllerUsage(f)).toBe(1);
});

test("retains pending evidence after a failed late upload without changing Session ACK", async () => {
  const f = await fixture(), before = f.read();
  const request: typeof fetch = async () => { throw new Error("offline"); };
  const result = await replayStoppedControllerUsage({ ...f, serverToken: "parent", request });
  expect(result.pending).toBeGreaterThan(0); expect(countStoppedControllerUsage(f)).toBe(1);
  expect(f.read().execution).toEqual(before.execution); expect(f.read().outbox).toEqual(before.outbox);
});

test("prevents explicit recording cleanup from deleting the sole pending usage journal", async () => {
  const f = await fixture(); await writeLaunchTicket(f.home, f.ticket);
  const task = { serverOrigin: f.ticket.serverOrigin, workerId: f.ticket.workerId, worktreeId: f.ticket.worktreeId, claimId: f.ticket.claimId, status: "done", cleanup: { kind: "terminal", discardRecording: true }, webExecution: { executionId: f.ticket.executionId, executionGeneration: f.ticket.executionGeneration, launchId: f.ticket.launchId, sessionId: f.ticket.sessionId } } as LocalTask;
  await expect(deleteWebRecording(f.home, task, () => task, () => true)).rejects.toThrow("pending or quarantined usage");
  expect(countStoppedControllerUsage(f)).toBe(1);
});
