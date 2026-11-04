import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Task } from "../../../src/api/types.js";
import { createHerdrArchiveApi, ensureHerdrRecordingResponsibility } from "../../../src/commands/worker/herdr/archive-api.js";
import { createHerdrSessionApi, type HerdrSessionState } from "../../../src/commands/worker/herdr/session-api.js";
import { createHerdrRecordingArchive } from "../../../src/commands/worker/herdr/recording-archive.js";
import { createHerdrRecordingResources } from "../../../src/commands/worker/herdr/recording-resources.js";
import { openHerdrRecordingStore } from "../../../src/commands/worker/herdr/recording-store.js";
import type { HerdrLifecycleRecord } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import { decodeSessionV2Archive, parseSessionV2Archive } from "../../../src/session/v2/archive.js";
import { parseSessionV2Message, sessionV2ReceiptDigest } from "../../../src/session/v2/protocol.js";
import { sourceDigest } from "../../../src/session/v2/responsibility.js";
import type { SessionV2Message } from "../../../src/session/v2/types.js";
const roots: string[] = [], servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }))); roots.splice(0).forEach(root => rmSync(root, { force: true, recursive: true })); });

describe("recording files through production archive HTTP and resource management", () => {
  it("recovers a lost upload response, verifies immutable bytes, and gates worktree cleanup on the receipt", async () => {
    mkdirSync("../../.tmp/herdr-archive-http-test", { recursive: true });
    const root = realpathSync(mkdtempSync(path.resolve("../../.tmp/herdr-archive-http-test/run-"))); roots.push(root);
    const doc = parseSessionV2Archive(JSON.parse(readFileSync(new URL("../../session/fixtures/v2/valid-archive.json", import.meta.url), "utf8")));
    let remote!: HerdrSessionState, receipt: Extract<SessionV2Message, { type: "receipt" }> | null = null, uploads = 0, freezes = 0, ledgers = 0;
    const errors: unknown[] = [], objectFile = path.join(root, "remote-object.json");
    // This local service is a contract fixture, not the PostgreSQL/Go implementation.
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => { void (async () => {
        expect(request.headers.authorization).toBe("Bearer original-owner-test-token");
        expect(request.headers["daynight-session-protocol"]).toBe("daynight.session.v2");
        const reply = (value: unknown) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); };
        if (request.method === "GET" && request.url?.endsWith("/state")) { reply(remote); return; }
        if (request.method === "GET" && request.url?.endsWith("/archive/receipt")) { if (!receipt) { response.statusCode = 409; reply({ error: { code: "archive_pending" } }); } else reply(receipt); return; }
        const bytes = Buffer.concat(chunks);
        if (request.method === "PUT" && request.url?.endsWith("/archive")) {
          const archive = await decodeSessionV2Archive(bytes); uploads++;
          expect(archive.finalizationId).toBe(remote.ledger.finalizationId); expect(archive.runs).toEqual(remote.ledger.runs);
          expect(await sourceDigest(archive, "1")).toBe(remote.recording[0]!.evidence!.sourceSha256);
          writeFileSync(objectFile, bytes);
          const stored = readFileSync(objectFile);
          receipt = { protocol: "daynight.session.v2", schemaVersion: 2, projectionVersion: 1, sessionId: archive.sessionId, claimId: archive.claimId, executionGeneration: archive.executionGeneration, agentControlMode: "herdr", contentKind: "terminal_recording", type: "receipt", payload: { finalizationId: archive.finalizationId, disposition: "ready", dispositionDigest: "0".repeat(64), reason: null, sha256: createHash("sha256").update(stored).digest("hex"), byteLength: String(stored.byteLength), completeness: archive.completeness, evidence: null } };
          receipt.payload.dispositionDigest = await sessionV2ReceiptDigest(receipt);
          remote.archive = { state: "ready", sha256: receipt.payload.sha256, byteLength: receipt.payload.byteLength, completeness: receipt.payload.completeness, errorCode: null, finalizationId: receipt.payload.finalizationId };
          request.socket.destroy(); return;
        }
        const message = parseSessionV2Message(JSON.parse(bytes.toString("utf8")));
        expect(request.headers["daynight-connection-epoch"]).toBe("1");
        if (message.type === "recording_responsibility") {
          expect(remote.ledger.runs[0]!.stopProof).toBeNull(); remote.recording = [{ executionGeneration: "1", responsibility: message.payload, evidence: null }]; reply(message); return;
        }
        if (message.type === "generation_ledger") { ledgers++; expect(remote.ledger.finalizationId).toBeNull(); remote.ledger = message.payload; remote.binding = message.payload.runs.at(-1)!.binding; reply(message); return; }
        if (message.type === "recording_evidence") { expect(message.payload.closed).toBe(true); expect(remote.ledger.runs[0]!.stopProof).not.toBeNull(); remote.recording[0]!.evidence = message.payload; reply(message); return; }
        if (message.type === "finalization") {
          freezes++; expect(remote.recording[0]!.evidence!.closed).toBe(true); expect(message.payload.runs).toEqual(remote.ledger.runs);
          remote.ledger.finalizationId = message.payload.finalizationId; reply({ ...message, type: "generation_ledger", payload: remote.ledger }); return;
        }
        throw new Error(`Unexpected contract request: ${request.method} ${request.url}`);
      })().catch(error => { errors.push(error); response.statusCode = 500; response.end(JSON.stringify({ error: { code: "fixture_failure" } })); }); });
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address.");
    const origin = `http://127.0.0.1:${address.port}`; doc.owner.serverOrigin = origin; doc.runs.forEach(run => { run.owner.serverOrigin = origin; });
    const envelope = { protocol: "daynight.session.v2" as const, schemaVersion: 2 as const, projectionVersion: 1 as const, sessionId: doc.sessionId, claimId: doc.claimId, executionGeneration: "1", agentControlMode: "herdr" as const, contentKind: "terminal_recording" as const };
    remote = { status: "registered", ...envelope, owner: doc.owner, binding: doc.runs[0]!.binding, connectionEpoch: "1", connected: false, capabilities: { observe: true, control: true, archive: true }, control: null, snapshot: null, ledger: { runs: doc.runs.map(run => ({ ...run, stoppedAt: null, stopProof: null })), finalizationId: null }, archive: { state: "pending", sha256: null, byteLength: null, completeness: null, errorCode: null, finalizationId: null }, recording: [] };
    const directory = path.join(root, "recordings"), cwd = path.join(root, "worktree"); mkdirSync(cwd);
    const owner = { projectId: doc.owner.projectId, taskId: doc.owner.taskId, claimId: doc.claimId, worktreeId: doc.owner.worktreeId };
    const record: HerdrLifecycleRecord = { owner: doc.owner, sessionId: doc.sessionId, claimId: doc.claimId, cwd, registrationId: doc.finalizationId, connectionEpoch: "1", registrationRequest: null, ledgerRequest: null, publishedLedgerHash: "a".repeat(64), controlEpoch: "1", initialAssignment: "transport_completed", initialPrompt: null, automationBlocked: true, preparation: null, runs: doc.runs.map(run => ({ run, phase: "stopped_confirmed", instanceDirectory: root, daemon: null, processes: [], stopOperationId: run.stopProof!.recordId, stopReason: "terminal", error: null, admission: null })), segments: doc.segments.map(segment => ({ ...segment, gap: null })), version: 1 };
    const sourceOptions = { directory: path.join(directory, doc.sessionId), owner: doc.owner, sessionId: doc.sessionId, claimId: doc.claimId };
    const source = openHerdrRecordingStore(sourceOptions), responsibility = source.registerRun("1");
    const api = createHerdrArchiveApi(origin, "original-owner-test-token"), session = createHerdrSessionApi(origin, "original-owner-test-token");
    await ensureHerdrRecordingResponsibility(api, { ...sourceOptions, executionGeneration: "1" }, { responsibilityId: responsibility.responsibilityId, recordingEnabled: true });
    source.openSegment({ ...record.segments[0]!, endedAt: null, durationMs: null });
    const screen = (text: string) => ({ width: 80, height: 1, rows: [[{ text, foreground: null, background: null, bold: false, italic: false, underline: false, inverse: false }]] });
    const at = (elapsed: number) => ({ elapsedMs: String(elapsed), capturedAt: new Date(Date.parse(doc.startedAt) + elapsed).toISOString() });
    const segment = record.segments[0]!.segmentId;
    source.sample(segment, screen("first 中文"), at(0)); source.sample(segment, screen("first 中文"), at(6000)); source.sample(segment, screen("second"), at(6500));
    source.interrupt(segment, "7000", at(7000).capturedAt); source.sample(segment, screen("third"), at(7500));
    source.endSegment(segment, { endedAt: doc.endedAt, durationMs: "10000" }); source.closeRun("1");
    expect(source.snapshot().files).toHaveLength(3); expect(source.snapshot().index[0]!.lastElapsedMs).toBe("6000");
    let now = 0;
    const archive = () => createHerdrRecordingArchive({ directory: path.join(root, "archives"), api, now: () => now });
    const resources = () => createHerdrRecordingResources({ directory, archive: archive(), list: () => [record], get: () => record, source: () => openHerdrRecordingStore(sourceOptions).snapshot(), publishStopped: async () => { await session.ledger({ ...envelope, type: "generation_ledger", payload: { runs: record.runs.map(run => run.run), finalizationId: null } }, "1"); }, readTask: async () => ({ id: owner.taskId, projectId: owner.projectId, status: "done", properties: {} } as Task) });
    const operation = createOperation();
    try {
      expect(await resources().advance(owner, operation)).toBe(false); expect(existsSync(cwd)).toBe(true); expect(archive().inspect(record)?.state).toBe("pending");
      now = 5000;
      expect(await resources().advance(owner, operation)).toBe(true); expect(uploads).toBe(1); expect(freezes).toBe(1); expect(ledgers).toBe(1);
      const result = await decodeSessionV2Archive(readFileSync(objectFile)); expect(result.completeness).toBe("partial"); expect(result.files).toHaveLength(3); expect(result.gaps).toHaveLength(1);
      expect(() => resources().cleaned(owner)).toThrow("still present"); rmdirSync(cwd); resources().cleaned(owner);
      expect(resources().resources()[0]).toMatchObject({ state: "ready", worktreeDeleted: true });
      expect(existsSync(sourceOptions.directory)).toBe(true); expect(BigInt(resources().resources()[0]!.sourceBytes)).toBeGreaterThan(BigInt(readFileSync(objectFile).byteLength));
      expect(errors).toEqual([]);
    } finally { operation.dispose(); }
  });
});
