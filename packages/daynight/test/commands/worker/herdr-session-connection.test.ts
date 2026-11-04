import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openHerdrLifecycleStore, type HerdrLifecycleStore } from "../../../src/commands/worker/herdr/lifecycle-store.js";
import type { HerdrLifecycleRecord, HerdrLocalRun, MacProcessIdentity } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import { createHerdrSessionApi, type HerdrSessionState } from "../../../src/commands/worker/herdr/session-api.js";
import { connectHerdrSession, publishHerdrLedger } from "../../../src/commands/worker/herdr/session-connection.js";
import type { SessionV2Message } from "../../../src/session/v2/types.js";
import { canonicalSessionJson } from "../../../src/session/v2/values.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const root = fileURLToPath(new URL("../../../../../.tmp/herdr-session-connection/", import.meta.url));
const processIdentity = (role: MacProcessIdentity["role"], pid: number): MacProcessIdentity => ({ role, pid, birthToken: `birth-${pid}`, bootId: "boot-one", auditToken: [501, 501, 20, 501, 20, pid, 100000, pid + 100], ppid: 1, pgid: pid, sid: pid });
const stores: HerdrLifecycleStore[] = [], directories: string[] = [], servers: Server[] = [];
type Registration = Extract<SessionV2Message, { type: "registration" }>;
type Ledger = Extract<SessionV2Message, { type: "generation_ledger" }>;
const base = (record: HerdrLifecycleRecord) => ({ protocol: "daynight.session.v2" as const, schemaVersion: 2 as const, projectionVersion: 1 as const, sessionId: record.sessionId, claimId: record.claimId, executionGeneration: record.runs.at(-1)!.run.executionGeneration, agentControlMode: "herdr" as const, contentKind: "terminal_recording" as const });
const requestFor = (record: HerdrLifecycleRecord): Registration => ({ ...base(record), type: "registration", payload: { registrationId: record.registrationId, mode: record.connectionEpoch === null ? "register" : "reconnect", connectionEpoch: record.connectionEpoch, owner: record.owner, binding: record.runs.at(-1)!.run.binding, capabilities: { observe: false, control: false, archive: false } } });
const stateFor = (record: HerdrLifecycleRecord, epoch = "1"): HerdrSessionState => ({ ...base(record), status: "registered", owner: record.owner, binding: record.runs.at(-1)!.run.binding, connectionEpoch: epoch, connected: false, capabilities: { observe: false, control: false, archive: false }, control: null, snapshot: null, ledger: { runs: record.runs.map(r => r.run), finalizationId: null }, archive: { state: "pending", sha256: null, byteLength: null, completeness: null, errorCode: null, finalizationId: null }, recording: [] });
const fixture = async () => {
  let observed: HerdrSessionState | null = null, loseRegistration = false, loseLedger = false, commitRegistration = true, commitLedger = true;
  let beforeRegistration: (() => void) | undefined, beforeLedger: (() => void) | undefined, stateStatus = 0;
  let currentResponse: unknown;
  const registrations: Registration[] = [], ledgers: Ledger[] = [], epochs: string[] = [], reads: string[] = [];
  const server = createServer((req, res) => {
    const reply = (value: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    if (req.method === "GET") {
      reads.push(req.url!);
      if (req.url?.endsWith("session-capabilities")) return reply({ protocol: "daynight.session.v2", schemaVersion: 2, projectionVersion: 1, providers: ["codex", "claude", "copilot"], backends: ["herdr"], recordingResponsibilityVersion: 1, controlDispatchVersion: 1, workerCapabilitiesRequired: true });
      if (stateStatus !== 0) { res.statusCode = stateStatus; return reply({ error: "state unavailable" }); }
      if (req.url?.endsWith("/current") && currentResponse !== undefined) return reply(currentResponse);
      if (observed !== null) return reply(observed);
      if (req.url?.endsWith("/current")) return reply({ status: "not_registered", protocol: "daynight.session.v2", claimId: uuid(6), agentControlMode: "herdr" });
      res.statusCode = 404; return reply({ error: "missing" });
    }
    const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(Buffer.from(chunk))); req.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString()) as Registration | Ledger;
      if (message.type === "registration") {
        beforeRegistration?.(); registrations.push(message);
        const epoch = String(BigInt(message.payload.connectionEpoch ?? "0") + 1n);
        if (commitRegistration) observed = { ...stateFor(store.get(identity)!, epoch), executionGeneration: message.executionGeneration, binding: message.payload.binding, ledger: observed?.ledger ?? { runs: [], finalizationId: null } };
        if (loseRegistration) return req.socket.destroy();
        return reply({ ...message, type: "registration_ack", payload: { registrationId: message.payload.registrationId, connectionEpoch: epoch } });
      }
      beforeLedger?.(); ledgers.push(message); epochs.push(String(req.headers["daynight-connection-epoch"]));
      if (commitLedger) observed = { ...observed!, executionGeneration: message.executionGeneration, binding: message.payload.runs.at(-1)!.binding, ledger: message.payload };
      if (loseLedger) return req.socket.destroy();
      reply(message);
    });
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("No test address.");
  const origin = `http://127.0.0.1:${address.port}`;
  mkdirSync(root, { recursive: true }); const directory = mkdtempSync(path.join(root, "run-")); directories.push(directory);
  const store = openHerdrLifecycleStore(path.join(directory, "journal.sqlite"), { onMigration: () => {} }); stores.push(store);
  const owner = { projectId: uuid(1), taskId: uuid(2), workerId: uuid(3), worktreeId: uuid(4), ownerUserId: uuid(5), serverOrigin: origin, provider: "codex" as const };
  const identity = { projectId: owner.projectId, taskId: owner.taskId, claimId: uuid(6) };
  let record = store.create({ owner, claimId: identity.claimId, cwd: directory });
  const run: HerdrLocalRun = { run: { executionGeneration: "1", owner, binding: { instanceId: "daemon-one", sessionId: "w", workspaceId: "workspace-one", paneId: "pane-one", terminalId: "terminal-one", nativeSessionId: uuid(10) }, startedAt: "2026-11-04T00:00:00.000Z", stoppedAt: null, stopProof: null, segmentIds: [] }, phase: "prepared", instanceDirectory: directory, daemon: null, processes: [], stopOperationId: null, stopReason: null, error: null, admission: null };
  record = store.update(record, draft => { draft.runs.push(run); });
  return { store, identity, record, api: createHerdrSessionApi(origin, "test-worker"), registrations, ledgers, epochs, reads,
    get state() { return observed; }, set state(value: HerdrSessionState | null) { observed = structuredClone(value); },
    configure(value: { loseRegistration?: boolean; loseLedger?: boolean; commitRegistration?: boolean; commitLedger?: boolean; beforeRegistration?: () => void; beforeLedger?: () => void; stateStatus?: number; currentResponse?: unknown }) { loseRegistration = value.loseRegistration ?? loseRegistration; loseLedger = value.loseLedger ?? loseLedger; commitRegistration = value.commitRegistration ?? commitRegistration; commitLedger = value.commitLedger ?? commitLedger; beforeRegistration = value.beforeRegistration ?? beforeRegistration; beforeLedger = value.beforeLedger ?? beforeLedger; stateStatus = value.stateStatus ?? stateStatus; currentResponse = value.currentResponse ?? currentResponse; },
  };
};
const stop = (f: Awaited<ReturnType<typeof fixture>>) => {
  let record = f.store.update(f.store.get(f.identity)!, draft => { draft.runs[0]!.daemon = processIdentity("daemon", 100); draft.runs[0]!.processes = [processIdentity("shell", 101), processIdentity("agent", 102)]; draft.runs[0]!.phase = "stop_intent"; draft.runs[0]!.stopOperationId = uuid(20); draft.runs[0]!.stopReason = "terminal"; });
  record = f.store.update(record, draft => { draft.runs[0]!.phase = "stopped_confirmed"; const run = draft.runs[0]!.run; run.stoppedAt = "2026-11-04T00:01:00.000Z"; run.stopProof = { recordId: uuid(20), executionGeneration: "1", binding: run.binding, bootId: "boot-one", stoppedAt: run.stoppedAt, method: "instances_exited", terminalStopped: true, processes: draft.runs[0]!.processes.map(({ role, pid, birthToken, bootId }) => ({ role: role as "shell" | "agent", pid, birthToken, bootId })) }; });
  return record;
};
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });

describe("persistent Herdr Session connection", () => {
  it("commits the exact registration before its first HTTP write", async () => {
    const f = await fixture(); let persisted: Registration | null = null;
    f.configure({ beforeRegistration: () => { persisted = f.store.get(f.identity)!.registrationRequest; } });
    await connectHerdrSession(f.store, f.identity, f.api);
    expect(persisted).toEqual(f.registrations[0]); expect(f.registrations).toHaveLength(1);
    expect(f.store.get(f.identity)).toMatchObject({ connectionEpoch: "1", registrationRequest: null });
  });
  it("reconciles a lost registration response without posting it again", async () => {
    const f = await fixture(); f.configure({ loseRegistration: true });
    await connectHerdrSession(f.store, f.identity, f.api);
    expect(f.registrations).toHaveLength(1); expect(f.store.get(f.identity)!.connectionEpoch).toBe("1");
  });
  it("only reads back a registration persisted before a crash", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.registrationRequest = requestFor(draft); }); f.state = stateFor(f.record);
    await connectHerdrSession(f.store, f.identity, f.api);
    expect(f.registrations).toHaveLength(0); expect(f.store.get(f.identity)!.connectionEpoch).toBe("1");
  });
  it.each(["withdrawn", "replaced"])("recovers the original reconnect after its claim is %s before publishing the stop", async claimState => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); f.state = stateFor(f.record);
    f.configure({ loseRegistration: true, beforeRegistration: () => { f.configure({ stateStatus: 503 }); } });
    await expect(connectHerdrSession(f.store, f.identity, f.api)).rejects.toThrow();
    const pending = f.store.get(f.identity)!.registrationRequest;
    expect(pending).toMatchObject({ sessionId: f.record.sessionId, claimId: f.identity.claimId, payload: { mode: "reconnect", connectionEpoch: "1" } });
    expect(f.state!.connectionEpoch).toBe("2");
    f.configure({ stateStatus: 0, currentResponse: claimState === "withdrawn"
      ? { status: "not_applicable", protocol: "daynight.session.v2" }
      : { ...stateFor(f.record), sessionId: uuid(99), claimId: uuid(98) } });
    const stopped = stop(f);
    const reopened = openHerdrLifecycleStore(path.join(f.record.cwd, "journal.sqlite")); stores.push(reopened);
    expect(reopened.get(f.identity)!.registrationRequest).toEqual(pending);
    f.reads.length = 0;
    await publishHerdrLedger(reopened, f.identity, f.api);
    expect(f.registrations).toHaveLength(1); expect(f.epochs).toEqual(["2"]);
    expect(f.ledgers).toEqual([{ ...base(stopped), type: "generation_ledger", payload: { runs: stopped.runs.map(run => run.run), finalizationId: null } }]);
    expect(reopened.get(f.identity)).toMatchObject({ connectionEpoch: "2", registrationRequest: null, ledgerRequest: null });
    expect(reopened.get(f.identity)!.publishedLedgerHash).not.toBeNull();
    expect(f.reads.length).toBeGreaterThan(0);
    expect(f.reads.every(url => url.endsWith(`/${f.record.sessionId}/state`))).toBe(true);
  });
  it("retains unknown registration when no matching result is observable", async () => {
    const f = await fixture(); f.configure({ loseRegistration: true, commitRegistration: false });
    await expect(connectHerdrSession(f.store, f.identity, f.api)).rejects.toThrow();
    await expect(connectHerdrSession(f.store, f.identity, f.api)).rejects.toThrow();
    expect(f.registrations).toHaveLength(1); expect(f.store.get(f.identity)!.registrationRequest).not.toBeNull();
  });
  it("rejects an observed epoch which cannot confirm the pending registration", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.registrationRequest = requestFor(draft); }); f.state = stateFor(f.record, "2");
    await expect(connectHerdrSession(f.store, f.identity, f.api)).rejects.toThrow();
    expect(f.registrations).toHaveLength(0); expect(f.store.get(f.identity)!.connectionEpoch).toBeNull();
  });
  it("reconnects the service generation before granting the locally prepared successor", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); const stopped = stop(f); f.state = stateFor(stopped);
    f.store.update(stopped, draft => { const next = structuredClone(f.record.runs[0]!); next.run.executionGeneration = "2"; next.run.startedAt = "2026-11-04T00:01:00.000Z"; next.run.binding.instanceId = "daemon-two"; next.run.binding.terminalId = "terminal-two"; draft.runs.push(next); });
    await connectHerdrSession(f.store, f.identity, f.api); await publishHerdrLedger(f.store, f.identity, f.api);
    expect(f.registrations[0]).toMatchObject({ executionGeneration: "1", payload: { mode: "reconnect", connectionEpoch: "1", binding: stopped.runs[0]!.run.binding } });
    expect(f.ledgers[0]!.executionGeneration).toBe("2"); expect(f.epochs).toEqual(["2"]);
  });
  it("submits a stopped ledger on the original epoch without registering again", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "3"; }); f.state = stateFor(f.record, "3"); stop(f);
    await publishHerdrLedger(f.store, f.identity, f.api);
    expect(f.registrations).toHaveLength(0); expect(f.epochs).toEqual(["3"]); expect(f.state!.ledger.runs[0]!.stopProof).not.toBeNull();
    expect(f.store.get(f.identity)!.publishedLedgerHash).toBe(createHash("sha256").update(canonicalSessionJson(f.state!.ledger)).digest("hex"));
  });
  it("confirms a lost ledger response only by the complete original fence and ledger", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); f.state = stateFor(f.record); stop(f); f.configure({ loseLedger: true });
    await publishHerdrLedger(f.store, f.identity, f.api);
    expect(f.ledgers).toHaveLength(1);
    expect(f.store.get(f.identity)!.publishedLedgerHash).toBe(createHash("sha256").update(canonicalSessionJson(f.state!.ledger)).digest("hex"));
    await publishHerdrLedger(f.store, f.identity, f.api); expect(f.ledgers).toHaveLength(1);
  });
  it("retains publication responsibility after a stopped ledger write is unconfirmed", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); f.state = stateFor(f.record); stop(f); f.configure({ loseLedger: true, commitLedger: false });
    await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow();
    expect(f.store.get(f.identity)!.publishedLedgerHash).toBeNull();
    await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow();
    expect(f.ledgers).toHaveLength(1);
    f.state = stateFor(f.store.get(f.identity)!); await publishHerdrLedger(f.store, f.identity, f.api);
    expect(f.ledgers).toHaveLength(1);
    expect(f.store.get(f.identity)!.publishedLedgerHash).toBe(createHash("sha256").update(canonicalSessionJson(f.state!.ledger)).digest("hex"));
  });
  it("publishes a deleted task's first stopped ledger after a definitive state 404", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "3"; }); f.state = stateFor(f.record, "3"); stop(f);
    let persisted: HerdrLifecycleRecord["ledgerRequest"] | undefined;
    f.configure({ stateStatus: 404, beforeLedger: () => { persisted = f.store.get(f.identity)!.ledgerRequest; } });
    await publishHerdrLedger(f.store, f.identity, f.api);
    expect(persisted).toEqual({ message: f.ledgers[0], connectionEpoch: "3" });
    expect(f.store.get(f.identity)!.ledgerRequest).toBeNull();
    expect(f.store.get(f.identity)!.publishedLedgerHash).toBe(createHash("sha256").update(canonicalSessionJson(f.state!.ledger)).digest("hex"));
    await publishHerdrLedger(f.store, f.identity, f.api); expect(f.ledgers).toHaveLength(1); expect(f.registrations).toHaveLength(0);
  });
  it("does not replay an unknown stopped publication when deleted task readback remains 404", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); f.state = stateFor(f.record); stop(f); f.configure({ stateStatus: 404, loseLedger: true });
    await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow();
    const pending = f.store.get(f.identity)!.ledgerRequest; expect(pending).not.toBeNull();
    const reopened = openHerdrLifecycleStore(path.join(f.record.cwd, "journal.sqlite")); stores.push(reopened);
    await expect(publishHerdrLedger(reopened, f.identity, f.api)).rejects.toThrow();
    await expect(connectHerdrSession(reopened, f.identity, f.api)).rejects.toThrow();
    expect(f.ledgers).toHaveLength(1); expect(f.registrations).toHaveLength(0);
    expect(reopened.get(f.identity)).toMatchObject({ ledgerRequest: pending, publishedLedgerHash: null, connectionEpoch: "1" });
  });
  it("never bypasses an unavailable state read for an unstopped run or non-404 failure", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); f.state = stateFor(f.record); f.configure({ stateStatus: 404 });
    await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow(); expect(f.ledgers).toHaveLength(0);
    stop(f); f.configure({ stateStatus: 503 });
    await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow(); expect(f.ledgers).toHaveLength(0);
    expect(f.store.get(f.identity)!.ledgerRequest).toBeNull();
  });
  it("reconciles an earlier pending ledger before publishing a subsequently confirmed stop", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); f.state = { ...stateFor(f.record), ledger: { runs: [], finalizationId: null } };
    f.configure({ loseLedger: true, beforeLedger: () => { f.configure({ stateStatus: 503 }); } });
    await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow();
    expect(f.ledgers).toHaveLength(1); expect(f.ledgers[0]!.payload.runs[0]!.stopProof).toBeNull();
    stop(f);
    f.configure({ stateStatus: 0, loseLedger: false, beforeLedger: () => {} });
    await publishHerdrLedger(f.store, f.identity, f.api);
    expect(f.ledgers).toHaveLength(2); expect(f.ledgers[1]!.payload.runs[0]!.stopProof).not.toBeNull();
    expect(f.store.get(f.identity)!.ledgerRequest).toBeNull();
    expect(f.store.get(f.identity)!.publishedLedgerHash).toBe(createHash("sha256").update(canonicalSessionJson(f.state!.ledger)).digest("hex"));
  });
  it("rejects a finalized or conflicting service ledger without another write", async () => {
    const f = await fixture(); f.store.update(f.record, draft => { draft.connectionEpoch = "1"; }); const stopped = stop(f); f.state = { ...stateFor(stopped), ledger: { runs: stopped.runs.map(r => r.run), finalizationId: uuid(30) } };
    await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow(); expect(f.ledgers).toHaveLength(0);
    f.state = stateFor(stopped, "2"); await expect(publishHerdrLedger(f.store, f.identity, f.api)).rejects.toThrow(); expect(f.ledgers).toHaveLength(0);
  });
});
