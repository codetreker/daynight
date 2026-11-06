import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { openHerdrLifecycleStore, type HerdrLifecycleStore } from "../../../src/commands/worker/herdr/lifecycle-store.js";
import type { HerdrLifecycleRecord, HerdrLocalRun, MacProcessIdentity } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import { createHerdrSessionApi, type HerdrSessionState } from "../../../src/commands/worker/herdr/session-api.js";
import type { SessionV2Message } from "../../../src/session/v2/types.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";

type Registration = Extract<SessionV2Message, { type: "registration" }>;
type Ledger = Extract<SessionV2Message, { type: "generation_ledger" }>;

export const createHerdrSessionConnectionFixtures = (storage: "memory" | "file") => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  const root = fileURLToPath(new URL("../../../../../.tmp/herdr-session-connection/", import.meta.url));

  const processIdentity = (role: MacProcessIdentity["role"], pid: number): MacProcessIdentity => ({ role, pid, birthToken: `birth-${pid}`, bootId: "boot-one", auditToken: [501, 501, 20, 501, 20, pid, 100000, pid + 100], ppid: 1, pgid: pid, sid: pid });

  const stores: HerdrLifecycleStore[] = [], directories: string[] = [], servers: Server[] = [];

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
    const store = openHerdrLifecycleStore(storage === "memory" ? createMemoryDatabase() : path.join(directory, "journal.sqlite"), { onMigration: () => {} }); stores.push(store);
    const owner = { projectId: uuid(1), taskId: uuid(2), workerId: uuid(3), worktreeId: uuid(4), ownerUserId: uuid(5), serverOrigin: origin, provider: "codex" as const };
    const identity = { projectId: owner.projectId, taskId: owner.taskId, claimId: uuid(6) };
    let record = store.create({ owner, claimId: identity.claimId, cwd: directory });
    const run: HerdrLocalRun = { run: { executionGeneration: "1", owner, binding: { instanceId: "daemon-one", sessionId: "w", workspaceId: "workspace-one", paneId: "pane-one", terminalId: "terminal-one", nativeSessionId: uuid(10) }, startedAt: "2026-11-04T00:00:00.000Z", stoppedAt: null, stopProof: null, segmentIds: [] }, phase: "prepared", nativeLaunch: "not_submitted", instanceDirectory: directory, daemon: null, processes: [], stopOperationId: null, stopReason: null, error: null, admission: null };
    record = store.update(record, draft => { draft.runs.push(run); });
    return { store, identity, record, api: createHerdrSessionApi(origin, "test-worker"), registrations, ledgers, epochs, reads,
      get state() { return observed; }, set state(value: HerdrSessionState | null) { observed = structuredClone(value); },
      configure(value: { loseRegistration?: boolean; loseLedger?: boolean; commitRegistration?: boolean; commitLedger?: boolean; beforeRegistration?: () => void; beforeLedger?: () => void; stateStatus?: number; currentResponse?: unknown }) { loseRegistration = value.loseRegistration ?? loseRegistration; loseLedger = value.loseLedger ?? loseLedger; commitRegistration = value.commitRegistration ?? commitRegistration; commitLedger = value.commitLedger ?? commitLedger; beforeRegistration = value.beforeRegistration ?? beforeRegistration; beforeLedger = value.beforeLedger ?? beforeLedger; stateStatus = value.stateStatus ?? stateStatus; currentResponse = value.currentResponse ?? currentResponse; },
    };
  };

  const stop = (f: Awaited<ReturnType<typeof fixture>>) => {
    let record = f.store.update(f.store.get(f.identity)!, draft => { draft.runs[0]!.phase = "launch_requested"; draft.runs[0]!.nativeLaunch = "requested"; });
    record = f.store.update(record, draft => { const run = draft.runs[0]!; run.phase = "active"; run.nativeLaunch = "observed"; run.daemon = processIdentity("daemon", 100); run.processes = [processIdentity("shell", 101), processIdentity("agent", 102)]; });
    record = f.store.update(record, draft => { draft.runs[0]!.daemon = processIdentity("daemon", 100); draft.runs[0]!.processes = [processIdentity("shell", 101), processIdentity("agent", 102)]; draft.runs[0]!.phase = "stop_intent"; draft.runs[0]!.stopOperationId = uuid(20); draft.runs[0]!.stopReason = "terminal"; });
    record = f.store.update(record, draft => { draft.runs[0]!.phase = "stopped_confirmed"; const run = draft.runs[0]!.run; run.stoppedAt = "2026-11-04T00:01:00.000Z"; run.stopProof = { recordId: uuid(20), executionGeneration: "1", binding: run.binding, bootId: "boot-one", stoppedAt: run.stoppedAt, method: "instances_exited", terminalStopped: true, processes: draft.runs[0]!.processes.map(({ role, pid, birthToken, bootId }) => ({ role: role as "shell" | "agent", pid, birthToken, bootId })) }; });
    return record;
  };

  afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
  return { uuid, stores, base, requestFor, stateFor, fixture, stop };
};
