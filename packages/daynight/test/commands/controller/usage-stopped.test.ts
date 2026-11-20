import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
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
import { createWebArchiveMaintenance } from "../../../src/commands/worker/web-archive-backfill.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { mapClaudeUsageEvent } from "../../../src/commands/controller/providers/claude-usage.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const capability = { profileId: "copilot-event-1.0.11-v1", qualification: "verified", measurementPlane: "native_event", revisionAuthority: "immutable", metrics: { inputTokens: "unknown", outputTokens: "supported", cacheReadTokens: "unknown", cacheWriteTokens: "unknown", reasoningTokens: "optional", totalTokens: "unknown" }, subagents: "included_per_event", recovery: "durable_after_ingress_only", completion: "partial_only" };
const fixture = async (prepare?: (journal: ReturnType<typeof openControllerLifecycleStore>) => void, provider: "copilot" | "codex" | "claude" = "copilot", standalone = false, grant: "valid" | "expired" | "none" = "valid", beforeMeasurement?: (journal: ReturnType<typeof openControllerLifecycleStore>) => void) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/usage-stopped-tests"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); roots.push(home);
  const executionId = randomUUID();
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId, controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", provider, cwd: home, nativeHome: path.join(home, ".copilot"), configuration: { agent: provider, agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: standalone ? "" : "original", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString(),
    ...(standalone ? { testExecutionId: executionId, ownerUserId: randomUUID(), usageScope: "standalone_test", initialInput: "none" } as const : { projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID() }) };
  const directory = controllerExecutionDirectory(home, ticket.executionId); await mkdir(directory, { recursive: true });
  const journalPath = path.join(directory, "journal.sqlite"), journal = openControllerLifecycleStore(journalPath, ticket, { contentOwnedLocally: true });
  const state = journal.usage.ensureState("1", randomUUID(), provider === "copilot" ? "1.0.11/1.0.105" : provider === "claude" ? "0.3.247/2.1.247/anthropic" : "0.169.0", provider);
  if (grant !== "none") journal.usage.saveGrant(state.stateId, { token: "g".repeat(43), expiresAt: new Date(Date.now() + (grant === "valid" ? 3_600_000 : -3_600_000)).toISOString() }, "1");
  beforeMeasurement?.(journal);
  if (provider === "copilot") journal.usage.enqueueMeasurement(state.stateId, { sourceKey: `copilot-event-v1:${randomUUID()}`, profileId: capability.profileId, revisionAuthority: "immutable", sourceRevision: "1", finality: "final", disposition: "active", aggregationRole: "counted", includedInSourceKey: null, nativeTurnId: null, nativeCallId: null, model: "model", metrics: { inputTokens: null, outputTokens: "17", cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, totalTokens: null, providerTotalTokens: null }, nativeMetrics: { outputTokens: "17" }, reasonCodes: [], observedAt: new Date().toISOString() });
  if (provider === "claude") journal.usage.enqueueMeasurement(state.stateId, mapClaudeUsageEvent({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_stopped", stop_reason: "end_turn", model: "claude-test", usage: { input_tokens: 17, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })!);
  journal.projectTimeline({ entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "text", text: "original content" }] });
  prepare?.(journal);
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

test.each([false, true])("replays original grants after native stop without sharing history ACKs (standalone %s)", async standalone => {
  const f = await fixture(undefined, "copilot", standalone), before = f.read(), paths: string[] = [], events: Record<string, unknown>[] = [];
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
  expect(await replayStoppedControllerUsage({ ...f, serverToken: "parent", request })).toEqual({ pending: 0, retryable: false });
  expect(events.filter(event => event.kind === "measurement")).toHaveLength(1);
  expect(events.find(event => event.kind === "execution_state")).toMatchObject({ collectionState: "partial", seal: true, reasonCodes: ["missing_final", "native_recovery_gap"] });
  expect(paths.some(value => value.endsWith("registrations") || value.endsWith("grant"))).toBe(false);
  const after = f.read(); expect(after.execution).toEqual(before.execution); expect(after.outbox).toEqual(before.outbox); expect(after.usage).toHaveLength(0);
});

test("rejects changed execution identity before network or acknowledgement", async () => {
  const f = await fixture(), request = vi.fn<typeof fetch>();
  await expect(replayStoppedControllerUsage({ ...f, ticket: { ...f.ticket, sessionId: randomUUID() }, serverToken: "parent", request })).rejects.toThrow();
  expect(request).not.toHaveBeenCalled(); expect(countStoppedControllerUsage(f)).toBe(1);
});

test.each([false, true])("retains pending evidence after a failed late upload without changing Session ACK (standalone %s)", async standalone => {
  const f = await fixture(undefined, "copilot", standalone), before = f.read();
  let unavailable = true;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("capabilities")) return Response.json({ protocol: "daynight.usage.v1", schemaVersion: 1, writeEnabled: true, profiles: [{ id: capability.profileId, provider: "copilot", capability: { ...capability, qualification: "unverified" }, qualifiedVersions: [{ providerVersion: f.state.providerVersion, capability }] }] });
    expect(url.pathname).toBe(`/api/usage/v1/states/${f.state.stateId}/batches`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"g".repeat(43)}`);
    if (unavailable) return new Response(null, { status: 503 });
    const body = JSON.parse(String(init?.body)) as { batchId: string; events: Record<string, unknown>[] };
    return Response.json({ protocol: "daynight.usage.v1", batchId: body.batchId, results: body.events.map(payload => ({ eventId: payload.eventId, sourceKey: payload.sourceKey ?? null, sourceRevision: payload.sourceRevision ?? null, stateSequence: payload.stateSequence ?? null, finality: payload.finality ?? null, outcome: "inserted", rowId: randomUUID(), rowVersion: "1", bodyHash: usageBodyHash(f.state, payload) })) });
  };
  const result = await replayStoppedControllerUsage({ ...f, serverToken: "parent", request });
  expect(result.pending).toBeGreaterThan(0); expect(result.retryable).toBe(true); expect(countStoppedControllerUsage(f)).toBeGreaterThan(0);
  expect(f.read().execution).toEqual(before.execution); expect(f.read().outbox).toEqual(before.outbox);
  unavailable = false;
  expect(await replayStoppedControllerUsage({ ...f, serverToken: "parent", request })).toEqual({ pending: 0, retryable: false });
  expect(f.read().usage).toEqual([]);
  expect(f.read().execution).toEqual(before.execution); expect(f.read().outbox).toEqual(before.outbox);
});

test.each([
  { grant: "none", provider: "codex" }, { grant: "expired", provider: "codex" },
  { grant: "none", provider: "copilot" }, { grant: "expired", provider: "copilot" },
] as const)("standalone $provider evidence with $grant grant is retained without promising a late upload", async ({ grant, provider }) => {
  const f = await fixture(undefined, provider, true, grant), before = f.read();
  const request = vi.fn<typeof fetch>(async input => {
    expect(new URL(String(input)).pathname).toBe("/api/usage/v1/capabilities");
    return Response.json({ protocol: "daynight.usage.v1", schemaVersion: 1, writeEnabled: false, profiles: [] });
  });
  expect(before.usage).toHaveLength(provider === "copilot" ? 1 : 0);
  expect(await replayStoppedControllerUsage({ ...f, serverToken: "parent", request })).toEqual({ pending: 1, retryable: false });
  expect(f.read()).toEqual(before);
  expect(countStoppedControllerUsage(f)).toBe(provider === "copilot" ? 1 : 0);
});

test("a revoked original grant leaves measurements retained without recommending archive retries", async () => {
  const f = await fixture(undefined, "copilot", true), before = f.read();
  const request: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("capabilities")) return Response.json({ protocol: "daynight.usage.v1", schemaVersion: 1, writeEnabled: true, profiles: [{ id: capability.profileId, provider: "copilot", capability, qualifiedVersions: [{ providerVersion: f.state.providerVersion, capability }] }] });
    expect(url.pathname).toBe(`/api/usage/v1/states/${f.state.stateId}/batches`);
    return new Response(null, { status: 403 });
  };
  const result = await replayStoppedControllerUsage({ ...f, serverToken: "parent", request });
  expect(result.pending).toBeGreaterThan(0); expect(result.retryable).toBe(false);
  expect(countStoppedControllerUsage(f)).toBeGreaterThan(0);
  expect(f.read().usage).toContainEqual(before.usage[0]);
  expect(f.read().execution).toEqual(before.execution); expect(f.read().outbox).toEqual(before.outbox);
});

test.each(["claude", "copilot"] as const)("unqualified %s measurements remain retained after state ACK without a spurious upload retry", async provider => {
  const f = await fixture(undefined, provider, true), before = f.read(), batches: Record<string, unknown>[][] = [];
  const cap = { ...capability, profileId: provider === "claude" ? "claude-message-input-0.3.247-v1" : capability.profileId };
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    // Even a verified default cannot qualify an unmatched exact native version.
    if (url.pathname.endsWith("capabilities")) return Response.json({ protocol: "daynight.usage.v1", schemaVersion: 1, writeEnabled: true, profiles: [{ id: cap.profileId, provider, capability: cap, qualifiedVersions: [] }] });
    expect(url.pathname).toBe(`/api/usage/v1/states/${f.state.stateId}/batches`);
    const body = JSON.parse(String(init?.body)) as { batchId: string; events: Record<string, unknown>[] }; batches.push(body.events);
    expect(body.events.every(payload => payload.kind === "execution_state")).toBe(true);
    return Response.json({ protocol: "daynight.usage.v1", batchId: body.batchId, results: body.events.map(payload => ({ eventId: payload.eventId, sourceKey: null, sourceRevision: null, stateSequence: payload.stateSequence, finality: null, outcome: "inserted", rowId: randomUUID(), rowVersion: "1", bodyHash: usageBodyHash(f.state, payload) })) });
  };
  expect(await replayStoppedControllerUsage({ ...f, serverToken: "parent", request })).toEqual({ pending: 1, retryable: false });
  expect(batches).toHaveLength(1);
  expect(f.read().usage).toEqual(before.usage);
  // The next archive call must not claim that it attempted the retained measurement.
  expect(await replayStoppedControllerUsage({ ...f, serverToken: "parent", request })).toEqual({ pending: 1, retryable: false });
  expect(batches).toHaveLength(1);
  expect(f.read().execution).toEqual(before.execution); expect(f.read().outbox).toEqual(before.outbox);
});

test.each(["promoted", "demoted", "metrics-changed", "reordered"] as const)("stopped Claude isolates incompatible state snapshots before selecting eligible measurements (%s)", async change => {
  const verified = { ...capability, profileId: "claude-message-input-0.3.247-v1" };
  const previous = change === "promoted" ? { ...verified, qualification: "unverified" } : verified;
  const current = change === "demoted" ? { ...verified, qualification: "unverified" }
    : change === "metrics-changed" ? { ...verified, metrics: { ...verified.metrics, inputTokens: "supported" } }
    : change === "reordered" ? Object.fromEntries(Object.entries({ ...verified, metrics: Object.fromEntries(Object.entries(verified.metrics).reverse()) }).reverse()) : verified;
  // More than one batch of old states precedes the measurement, including for
  // canReplay's limit=1 selection after the upload.
  const oldCount = change === "promoted" ? 101 : 1;
  const f = await fixture(undefined, "claude", true, "valid", journal => {
    const state = journal.usage.states()[0]!;
    for (let i = 0; i < oldCount; i++) journal.usage.enqueueState(state.stateId, { collectionState: previous.qualification === "unverified" ? "unavailable" : "partial", capability: previous, reasonCodes: ["profile_unverified", "native_recovery_gap", "subagent_scope_unknown"], nativeStartedAt: null, nativeEndedAt: new Date().toISOString(), observedAt: new Date().toISOString(), seal: true });
  }), before = f.read(), batches: Record<string, unknown>[][] = [];
  let invalidBatches = 0;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("capabilities")) return Response.json({ protocol: "daynight.usage.v1", schemaVersion: 1, writeEnabled: true, profiles: [{ id: verified.profileId, provider: "claude", capability: current, qualifiedVersions: [{ providerVersion: f.state.providerVersion, capability: current }] }] });
    expect(url.pathname).toBe(`/api/usage/v1/states/${f.state.stateId}/batches`);
    const body = JSON.parse(String(init?.body)) as { batchId: string; events: Record<string, unknown>[] }; batches.push(body.events);
    // The real service validates every state capability before applying any
    // measurement or checking whether the state revision is stale.
    if (body.events.some(event => event.kind === "execution_state" && !isDeepStrictEqual(event.capability, current))) {
      invalidBatches++; return Response.json({ error: { code: "invalid_state" } }, { status: 400 });
    }
    return Response.json({ protocol: "daynight.usage.v1", batchId: body.batchId, results: body.events.map(payload => ({ eventId: payload.eventId, sourceKey: payload.sourceKey ?? null, sourceRevision: payload.sourceRevision ?? null, stateSequence: payload.stateSequence ?? null, finality: payload.finality ?? null, outcome: "inserted", rowId: randomUUID(), rowVersion: "1", bodyHash: usageBodyHash(f.state, payload) })) });
  };
  const retained = change === "reordered" ? 0 : oldCount + (change === "demoted" ? 1 : 0);
  expect(await replayStoppedControllerUsage({ ...f, serverToken: "parent", request })).toEqual({ pending: retained, retryable: false });
  expect(invalidBatches).toBe(0);
  expect(batches.flat().filter(event => event.kind === "measurement")).toHaveLength(change === "demoted" ? 0 : 1);
  const remaining = f.read();
  if (change !== "reordered") expect(remaining.usage.filter(row => JSON.parse((row as { payload: string }).payload).kind === "execution_state")).toEqual(before.usage.filter(row => JSON.parse((row as { payload: string }).payload).kind === "execution_state"));
  const db = new Database(f.journalPath, { readonly: true });
  try { expect((db.prepare("SELECT count(*) AS count FROM usage_outbox WHERE quarantined=1").get() as { count: number }).count).toBe(change === "reordered" ? 0 : oldCount); }
  finally { db.close(); }
  expect(remaining.execution).toEqual(before.execution); expect(remaining.outbox).toEqual(before.outbox);
});

test.each([200, 401, 404, 501, 503])("known capability refusal differs from a transient failure (%s) with measurement-only retention", async status => {
  const f = await fixture(journal => {
    const state = journal.usage.states()[0]!;
    const event = journal.usage.enqueueState(state.stateId, { collectionState: "partial", capability, reasonCodes: [], nativeStartedAt: null, nativeEndedAt: new Date().toISOString(), observedAt: new Date().toISOString(), seal: true });
    expect(journal.usage.acknowledge([event], [{ eventId: event.eventId, sourceKey: null, sourceRevision: null, stateSequence: String(event.payload.stateSequence), finality: null, outcome: "inserted", bodyHash: event.bodyHash }])).toBe(true);
  }, "copilot", true), before = f.read();
  const request = vi.fn<typeof fetch>(async input => {
    expect(new URL(String(input)).pathname).toBe("/api/usage/v1/capabilities");
    return status === 200 ? Response.json({ protocol: "daynight.usage.v1", schemaVersion: 1, writeEnabled: false, profiles: [] }) : new Response(null, { status });
  });
  expect(await replayStoppedControllerUsage({ ...f, serverToken: "parent", request })).toEqual({ pending: 1, retryable: status === 503 });
  expect(request).toHaveBeenCalledOnce(); expect(f.read()).toEqual(before);
  expect(countStoppedControllerUsage(f)).toBe(1);
});

test.each(["missing", "invalid"])("a known %s profile does not make retained state events perpetually retryable", async kind => {
  const f = await fixture(journal => {
    const state = journal.usage.states()[0]!;
    journal.usage.enqueueState(state.stateId, { collectionState: "partial", capability, reasonCodes: [], nativeStartedAt: null, nativeEndedAt: new Date().toISOString(), observedAt: new Date().toISOString(), seal: true });
  }, "copilot", true), before = f.read();
  const request: typeof fetch = async input => {
    if (new URL(String(input)).pathname.endsWith("capabilities")) return Response.json({ protocol: "daynight.usage.v1", schemaVersion: 1, writeEnabled: true, profiles: kind === "missing" ? [] : [{ id: capability.profileId, provider: "copilot", capability: { ...capability, qualification: "invalid" }, qualifiedVersions: [] }] });
    return new Response(null, { status: 503 });
  };
  expect(await replayStoppedControllerUsage({ ...f, serverToken: "parent", request })).toEqual({ pending: 2, retryable: false });
  expect(f.read()).toEqual(before); expect(countStoppedControllerUsage(f)).toBe(2);
});

test("prevents explicit recording cleanup from deleting the sole pending usage journal", async () => {
  const f = await fixture(); await writeLaunchTicket(f.home, f.ticket);
  const task = { serverOrigin: f.ticket.serverOrigin, workerId: f.ticket.workerId, worktreeId: f.ticket.worktreeId, claimId: f.ticket.claimId, status: "done", cleanup: { kind: "terminal", discardRecording: true }, webExecution: { executionId: f.ticket.executionId, executionGeneration: f.ticket.executionGeneration, launchId: f.ticket.launchId, sessionId: f.ticket.sessionId } } as LocalTask;
  await expect(deleteWebRecording(f.home, task, () => task, () => true)).rejects.toThrow("pending or quarantined usage");
  expect(countStoppedControllerUsage(f)).toBe(1);
});

test.each(["explicit", "automatic"] as const)("retains ACKed local conflict evidence during %s recording discard", async mode => {
  const f = await fixture(journal => {
    const state = journal.usage.states()[0]!;
    const original = journal.usage.pending(state.stateId)[0]!;
    expect(journal.usage.enqueueMeasurement(state.stateId, { ...original.payload, model: "contradiction" })).toBe("conflict");
    journal.usage.enqueueState(state.stateId, { collectionState: "partial", capability, reasonCodes: [], nativeStartedAt: null, nativeEndedAt: null, observedAt: new Date().toISOString(), seal: true });
    const flight = journal.usage.pending(state.stateId);
    expect(journal.usage.acknowledge(flight, flight.map(item => ({ eventId: item.eventId, sourceKey: item.payload.sourceKey as string ?? null, sourceRevision: item.payload.sourceRevision as string ?? null, stateSequence: item.payload.stateSequence as string ?? null, finality: item.payload.finality as string ?? null, outcome: "inserted", bodyHash: item.bodyHash })))).toBe(true);
  });
  await writeLaunchTicket(f.home, f.ticket);
  expect(f.read().usage).toEqual([]);
  expect(countStoppedControllerUsage(f)).toBe(1);
  const request: typeof fetch = async input => {
    expect(new URL(String(input)).pathname.endsWith("capabilities")).toBe(true);
    return Response.json({ protocol: "daynight.usage.v1", schemaVersion: 1, writeEnabled: false, profiles: [] });
  };
  expect(await replayStoppedControllerUsage({ ...f, serverToken: "parent", request })).toEqual({ pending: 1, retryable: false });
  let task = { projectId: f.ticket.projectId, taskId: f.ticket.taskId, serverOrigin: f.ticket.serverOrigin, workerId: f.ticket.workerId, userId: f.ticket.userId, worktreeId: f.ticket.worktreeId, claimId: f.ticket.claimId, status: "done", cleanup: { kind: "terminal", discardRecording: mode === "explicit" }, webExecution: { executionId: f.ticket.executionId, executionGeneration: f.ticket.executionGeneration, launchId: f.ticket.launchId, sessionId: f.ticket.sessionId } } as LocalTask;
  if (mode === "explicit") {
    await expect(deleteWebRecording(f.home, task, () => task, () => true)).rejects.toThrow("unresolved local conflicts");
  } else {
    // The scheduler's task selection is controlled; journal admission and deletion stay real.
    type MaintenanceWebStore = Parameters<typeof createWebArchiveMaintenance>[0]["webStore"];
    const selectedStore: Pick<MaintenanceWebStore, "listCompletedTasks" | "getTask" | "discardRecording"> = { listCompletedTasks: () => [task], getTask: () => task, discardRecording: () => (task = { ...task, cleanup: { ...task.cleanup!, discardRecording: true } }) };
    const webStore = selectedStore as MaintenanceWebStore;
    const worker = openWorkerStore(path.join(f.home, "worker.sqlite")), signal = new AbortController();
    let failed!: () => void;
    const rejected = new Promise<void>(resolve => { failed = resolve; });
    const emit = vi.fn<Parameters<typeof createWebArchiveMaintenance>[0]["emit"]>(event => { if (event.kind === "cleanup-error") failed(); });
    const maintenance = createWebArchiveMaintenance({ homeDirectory: f.home, serverUrl: f.ticket.serverOrigin, workerId: f.ticket.workerId!, userId: f.ticket.userId!, signal: signal.signal, store: worker, webStore, archive: async () => {}, probeArchive: async () => ({ kind: "attempt" }), emit });
    try {
      await maintenance.discardLocal(() => true, false, signal.signal);
      await rejected;
      expect(task.cleanup?.discardRecording).toBe(true);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "cleanup-error", error: expect.objectContaining({ message: expect.stringContaining("unresolved local conflicts") }) }));
    } finally { await maintenance.close(); worker.close(); }
  }
  expect((await stat(f.journalPath)).isFile()).toBe(true);
  expect(countStoppedControllerUsage(f)).toBe(1);
  const db = new Database(f.journalPath, { readonly: true });
  try { expect(JSON.parse((db.prepare("SELECT value FROM usage_meta WHERE key='source_conflict'").get() as { value: string }).value)).toMatchObject({ acceptedHash: expect.any(String), rejectedHash: expect.any(String) }); }
  finally { db.close(); }
});

test("stopped Codex capability stays unsupported instead of becoming a failed collector", async () => {
  const f = await fixture(undefined, "codex"), events: Record<string, unknown>[] = [];
  const cap = { ...capability, profileId: "codex-snapshot-unaccountable-v1", qualification: "unsupported", measurementPlane: "none", revisionAuthority: "none", recovery: "unsupported", completion: "unsupported" };
  const request: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith("capabilities")) return Response.json({ protocol: "daynight.usage.v1", schemaVersion: 1, writeEnabled: true, profiles: [{ id: cap.profileId, provider: "codex", capability: cap, qualifiedVersions: [] }] });
    const body = JSON.parse(String(init?.body)) as { batchId: string; events: Record<string, unknown>[] }; events.push(...body.events);
    const db = new Database(f.journalPath, { readonly: true });
    try {
      const rows = db.prepare("SELECT event_id,body_hash FROM usage_outbox").all() as { event_id: string; body_hash: string }[];
      return Response.json({ protocol: "daynight.usage.v1", batchId: body.batchId, results: body.events.map(event => ({ eventId: event.eventId, sourceKey: null, sourceRevision: null, stateSequence: event.stateSequence, finality: null, outcome: "inserted", rowId: randomUUID(), rowVersion: "1", bodyHash: rows.find(row => row.event_id === event.eventId)!.body_hash })) });
    } finally { db.close(); }
  };
  expect(await replayStoppedControllerUsage({ journalPath: f.journalPath, ticket: f.ticket, serverToken: "parent-token", request })).toEqual({ pending: 0, retryable: false });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: "execution_state", collectionState: "unsupported", reasonCodes: ["provider_unsupported"], seal: true });
});
