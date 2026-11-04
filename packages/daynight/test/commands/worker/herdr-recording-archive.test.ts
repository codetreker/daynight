import { createHash } from "node:crypto";
import { fstatSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHerdrRecordingArchive } from "../../../src/commands/worker/herdr/recording-archive.js";
import { HerdrArchiveHttpError, type HerdrArchiveApi } from "../../../src/commands/worker/herdr/archive-api.js";
import type { HerdrLifecycleRecord } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import type { HerdrRecordingSnapshot } from "../../../src/commands/worker/herdr/recording-types.js";
import { parseSessionV2Archive } from "../../../src/session/v2/archive.js";
import { canonicalSessionJson } from "../../../src/session/v2/values.js";
import { sessionV2ReceiptDigest } from "../../../src/session/v2/protocol.js";
import type { SessionV2Message } from "../../../src/session/v2/types.js";
import type { HerdrSessionState } from "../../../src/commands/worker/herdr/session-api.js";
import { createOperation } from "../../../src/api/operation.js";
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fixture = (name = "valid-archive") => parseSessionV2Archive(JSON.parse(readFileSync(new URL(`../../session/fixtures/v2/${name}.json`, import.meta.url), "utf8")));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const setup = (name = "valid-archive") => {
  mkdirSync("../../.tmp/herdr-archive-test", { recursive: true });
  const directory = mkdtempSync(path.resolve("../../.tmp/herdr-archive-test/run-")); roots.push(directory);
  const doc = fixture(name), envelope = { protocol: "daynight.session.v2" as const, schemaVersion: 2 as const, projectionVersion: 1 as const, sessionId: doc.sessionId, claimId: doc.claimId, executionGeneration: doc.executionGeneration, agentControlMode: "herdr" as const, contentKind: "terminal_recording" as const };
  const record: HerdrLifecycleRecord = { owner: doc.owner, claimId: doc.claimId, sessionId: doc.sessionId, cwd: directory, registrationId: id(90), connectionEpoch: "1", registrationRequest: null, ledgerRequest: null, publishedLedgerHash: "a".repeat(64), controlEpoch: "1", initialAssignment: "transport_completed", initialPrompt: null, automationBlocked: true, preparation: null, runs: doc.runs.map(run => ({ run, phase: "stopped_confirmed", instanceDirectory: directory, daemon: null, processes: [], stopOperationId: run.stopProof!.recordId, stopReason: "terminal", error: null, admission: null })), segments: doc.segments.map(segment => ({ ...segment, gap: null })), version: 1 };
  const source: HerdrRecordingSnapshot = { schemaVersion: 1, owner: doc.owner, sessionId: doc.sessionId, claimId: doc.claimId, runs: doc.runs.map((run, index) => ({ executionGeneration: run.executionGeneration, responsibilityId: id(91 + index), recordingEnabled: true, selectedFrameCount: String(doc.files.filter(file => run.segmentIds.includes(file.segmentId)).length), registeredFrameCount: String(doc.files.filter(file => run.segmentIds.includes(file.segmentId)).length), captureError: null, closed: true })), segments: doc.segments, files: doc.files, index: doc.index, gaps: doc.gaps, journalSha256: "b".repeat(64) };
  const remote: HerdrSessionState = { status: "registered", ...envelope, owner: doc.owner, binding: doc.runs.at(-1)!.binding, connectionEpoch: "1", connected: false, capabilities: { observe: true, control: true, archive: true }, control: null, snapshot: null, ledger: { runs: doc.runs, finalizationId: null }, archive: { state: "pending", sha256: null, byteLength: null, completeness: null, errorCode: null, finalizationId: null }, recording: source.runs.map(run => ({ executionGeneration: run.executionGeneration, responsibility: { responsibilityId: run.responsibilityId, recordingEnabled: run.recordingEnabled }, evidence: null })) };
  let finalizes = 0, uploads = 0, reads = 0, clock = 0, loseFinalization = false, loseUpload = false, permission = false;
  let receipt: Extract<SessionV2Message, { type: "receipt" }> | null = null;
  const bodies: string[] = [];
  const api: HerdrArchiveApi = {
    state: async () => { reads++; if (permission) throw new HerdrArchiveHttpError(403, "permission_denied"); return structuredClone(remote); },
    recording: async (_expected, message) => { const m = message as SessionV2Message; if (m.type === "recording_evidence") remote.recording.find(run => run.executionGeneration === m.executionGeneration)!.evidence = m.payload; return message; },
    finalize: async (_expected, message) => { finalizes++; remote.ledger.finalizationId = message.payload.finalizationId; if (loseFinalization) { loseFinalization = false; throw new Error("lost finalization response"); } return { ...envelope, type: "generation_ledger", payload: remote.ledger }; },
    receipt: async () => { if (!receipt) throw new HerdrArchiveHttpError(409, "archive_pending"); return receipt; },
    upload: async (_expected, body) => {
      uploads++; bodies.push(body); const archive = parseSessionV2Archive(JSON.parse(body));
      receipt = { ...envelope, type: "receipt", payload: { finalizationId: archive.finalizationId, disposition: "ready", dispositionDigest: "0".repeat(64), reason: null, sha256: createHash("sha256").update(body).digest("hex"), byteLength: String(Buffer.byteLength(body)), completeness: archive.completeness, evidence: null } };
      receipt.payload.dispositionDigest = await sessionV2ReceiptDigest(receipt);
      remote.archive = { state: "ready", sha256: receipt.payload.sha256, byteLength: receipt.payload.byteLength, completeness: receipt.payload.completeness, errorCode: null, finalizationId: receipt.payload.finalizationId };
      if (loseUpload) { loseUpload = false; throw new Error("lost upload response"); } return receipt;
    },
    unavailable: async (_expected, message) => { receipt = message; remote.archive = { state: "unavailable", sha256: null, byteLength: null, completeness: null, errorCode: message.payload.reason, finalizationId: message.payload.finalizationId }; return message; },
    failed: async (_expected, message) => { remote.archive = message.payload; return message; },
  };
  const open = () => createHerdrRecordingArchive({ directory, api, now: () => clock });
  return { directory, record, source, remote, api, open, bodies, counts: () => ({ finalizes, uploads, reads }), time: (value: number) => { clock = value; }, loseFinalization: () => { loseFinalization = true; }, loseUpload: () => { loseUpload = true; }, permission: (value: boolean) => { permission = value; } };
};
describe("persistent Herdr archive finalization", () => {
  it.skipIf(process.platform === "win32")("does not authorize disposal or readback while its journal directory sync keeps failing", async () => {
    const s = setup(), archive = s.open(), root = statSync(s.directory);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const request = { operationId: id(93), action: "delete" as const, phase: "intent" as const };
    vi.mocked(fsyncSync).mockImplementation(fd => {
      const target = fstatSync(fd);
      if (target.isDirectory() && target.dev === root.dev && target.ino === root.ino) throw new Error("journal directory sync failed");
      actual.fsyncSync(fd);
    });
    try {
      expect(() => archive.disposition(s.record, request)).toThrow(/unconfirmed/);
      expect(() => archive.inspect(s.record)).toThrow(/durability/);
      expect(s.counts()).toEqual({ finalizes: 0, uploads: 0, reads: 0 });
    } finally { vi.mocked(fsyncSync).mockRestore(); }
    expect(archive.inspect(s.record)?.disposition?.phase).toBe("intent");
    expect(archive.disposition(s.record, request).disposition?.operationId).toBe(request.operationId);
  });
  it.skipIf(process.platform === "win32")("repeats the durability barrier before adopting a visible journal after one sync failure", async () => {
    const s = setup(), archive = s.open(), root = statSync(s.directory);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs"); let attempts = 0;
    vi.mocked(fsyncSync).mockImplementation(fd => {
      const target = fstatSync(fd);
      if (target.isDirectory() && target.dev === root.dev && target.ino === root.ino && ++attempts === 1) throw new Error("one sync failure");
      actual.fsyncSync(fd);
    });
    try {
      expect(archive.disposition(s.record, { operationId: id(93), action: "delete", phase: "intent" }).disposition?.phase).toBe("intent");
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally { vi.mocked(fsyncSync).mockRestore(); }
  });

  it.skipIf(process.platform === "win32")("refuses archive startup when its new root parent cannot be synced", async () => {
    const s = setup(), directory = path.join(s.directory, "herdr-archives"), parent = statSync(s.directory);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fsyncSync).mockImplementation(fd => {
      const target = fstatSync(fd);
      if (target.isDirectory() && target.dev === parent.dev && target.ino === parent.ino) throw new Error("parent directory sync failed");
      actual.fsyncSync(fd);
    });
    try {
      expect(() => createHerdrRecordingArchive({ directory, api: s.api })).toThrow("parent directory sync failed");
      expect(() => createHerdrRecordingArchive({ directory, api: s.api })).toThrow("parent directory sync failed");
      expect(s.counts()).toEqual({ finalizes: 0, uploads: 0, reads: 0 });
      expect(s.remote.archive.state).toBe("pending");
    } finally { vi.mocked(fsyncSync).mockRestore(); }
    const archive = createHerdrRecordingArchive({ directory, api: s.api });
    expect(archive.inspect(s.record)).toBeNull();
    expect((await archive.advance(s.record, () => s.source)).state).toBe("ready");
  });
  it("recovers finalization and upload response loss without another ID or another upload", async () => {
    const s = setup(); s.loseFinalization();
    expect((await s.open().advance(s.record, () => s.source)).state).toBe("pending");
    const original = s.open().inspect(s.record)!.finalization!.payload.finalizationId;
    s.time(5000); s.loseUpload(); expect((await s.open().advance(s.record, () => s.source)).state).toBe("pending");
    s.time(15000); const result = await s.open().advance(s.record, () => s.source);
    expect(result.state).toBe("ready"); expect(result.receipt!.payload.finalizationId).toBe(original); expect(s.counts()).toMatchObject({ finalizes: 1, uploads: 1 });
    expect(s.open().cleaned(s.record).worktreeDeleted).toBe(true);
    expect((await s.open().advance(s.record, () => { throw new Error("must not rebuild receipt"); })).state).toBe("ready");
  });
  it("retains failed sources and never converts missing recording responsibility to unavailable", async () => {
    const s = setup(); s.remote.recording = [];
    const result = await s.open().advance(s.record, () => s.source);
    expect(result.state).toBe("failed"); expect(result.nextAttemptAt).toBeNull(); expect(s.counts().uploads).toBe(0);
    expect(s.remote.archive.state).toBe("failed");
    expect(() => s.open().retry(s.record)).toThrow();
    expect(() => s.open().cleaned(s.record)).toThrow();
  });
  it("accepts genuine zero-frame unavailable, but permanently retains capture failure", async () => {
    const s = setup(); s.source.files = []; s.source.index = []; s.source.runs[0]!.selectedFrameCount = "0"; s.source.runs[0]!.registeredFrameCount = "0";
    const result = await s.open().advance(s.record, () => s.source); expect(result.state).toBe("unavailable"); expect(result.receipt!.payload.reason).toBe("ended_before_first_sample");
    const broken = setup(); broken.source.files = []; broken.source.index = []; broken.source.runs[0]!.captureError = "source_corrupt";
    expect((await broken.open().advance(broken.record, () => broken.source)).state).toBe("failed");
  });
  it("stops automatic retries for permission errors until explicit same-owner retry", async () => {
    const s = setup(); s.permission(true); expect((await s.open().advance(s.record, () => s.source)).state).toBe("permission_denied"); const reads = s.counts().reads;
    s.time(999999); await s.open().advance(s.record, () => s.source); expect(s.counts().reads).toBe(reads);
    s.permission(false); s.open().retry(s.record); expect((await s.open().advance(s.record, () => s.source)).state).toBe("ready");
    expect(() => s.open().inspect({ ...s.record, owner: { ...s.record.owner, ownerUserId: id(99) } })).toThrow();
  });
  it("bounds exponential backoff and refuses stopped or corrupted-journal shortcuts", async () => {
    const s = setup(); s.api.state = async () => { throw new Error("network down"); }; let clock = 0;
    for (let attempt = 0; attempt < 10; attempt++) { const state = await s.open().advance(s.record, () => s.source); const delay = Math.min(5000 * 2 ** attempt, 300000); expect(state.nextAttemptAt).toBe(clock + delay); clock += delay; s.time(clock); }
    const active = structuredClone(s.record); active.runs[0]!.phase = "stop_unknown"; expect(() => s.open().disposition(active, { operationId: id(96), action: "delete", phase: "intent" })).toThrow();
    const file = path.join(s.directory, `${s.record.sessionId}.archive-state.json`); writeFileSync(file, canonicalSessionJson({ corrupt: true })); expect(() => s.open().inspect(s.record)).toThrow();
  });
  it("reconciles an accepted closed-evidence request after its response is lost", async () => {
    const s = setup(), publish = s.api.recording; let calls = 0;
    s.api.recording = async (...args) => { calls++; await publish(...args); throw new Error("closed-evidence response lost"); };
    expect((await s.open().advance(s.record, () => s.source)).state).toBe("pending");
    s.time(5000); expect((await s.open().advance(s.record, () => s.source)).state).toBe("ready"); expect(calls).toBe(1);
  });
  it("keeps remote ready immutable when the local fixed seal is corrupted", async () => {
    const s = setup(); s.loseUpload(); expect((await s.open().advance(s.record, () => s.source)).state).toBe("pending");
    writeFileSync(path.join(s.directory, `${s.record.sessionId}.archive-seal.json`), "{}");
    s.time(5000); expect((await s.open().advance(s.record, () => s.source)).state).toBe("failed");
    expect(s.remote.archive.state).toBe("ready"); expect(s.counts().uploads).toBe(1); expect(() => s.open().cleaned(s.record)).toThrow();
  });
  it("never freezes or uploads corrupt frames and preserves disposal intent and results", async () => {
    const s = setup(); s.source.files[0]!.sha256 = "f".repeat(64);
    expect((await s.open().advance(s.record, () => s.source)).state).toBe("failed"); expect(s.counts()).toMatchObject({ finalizes: 0, uploads: 0 });
    expect(() => s.open().disposition(s.record, { operationId: id(97), action: "delete", phase: "completed" })).toThrow();
    const intent = s.open().disposition(s.record, { operationId: id(97), action: "delete", phase: "intent" });
    expect(intent.worktreeDeleted).toBe(false); expect(intent.receipt).toBeNull();
    expect(() => s.open().disposition(s.record, { operationId: id(98), action: "delete", phase: "intent" })).toThrow();
    const completed = s.open().disposition(s.record, { operationId: id(97), action: "delete", phase: "completed" });
    expect(completed.state).toBe("failed"); expect(completed.worktreeDeleted).toBe(true); expect(completed.receipt).toBeNull();
    expect((await s.open().advance(s.record, () => { throw new Error("disposed sources must not be reopened"); })).disposition?.phase).toBe("completed");
  });
  it("refuses a concurrent ledger advance rather than freezing a replacement run", async () => {
    const s = setup(); s.remote.executionGeneration = "2";
    expect((await s.open().advance(s.record, () => s.source)).state).toBe("failed"); expect(s.counts().finalizes).toBe(0);
  });
  it("does not reprocess permanent source damage while retrying its failed-state announcement", async () => {
    const s = setup(); s.remote.recording = [];
    const publish = s.api.failed; let calls = 0;
    s.api.failed = async (...args) => { calls++; await publish(...args); throw new Error("failure response lost"); };
    const failed = await s.open().advance(s.record, () => s.source); expect(failed.state).toBe("failed"); expect(failed.nextAttemptAt).toBe(5000);
    s.time(5000); const observed = await s.open().advance(s.record, () => { throw new Error("must not reprocess corrupt source"); });
    expect(observed.failurePublished).toBe(true); expect(observed.nextAttemptAt).toBeNull(); expect(calls).toBe(1);
  });
  it("keeps multi-run chronology by generation when the wall clock rolls back", async () => {
    const s = setup("valid-multiple-runs-clock-rollback");
    expect((await s.open().advance(s.record, () => s.source)).state).toBe("ready");
    const result = JSON.parse(s.bodies[0]!) as { startedAt: string; endedAt: string };
    expect(result.startedAt).toBe("2026-11-03T09:00:00Z"); expect(result.endedAt).toBe("2026-11-03T10:00:10Z");
  });
  it("hashes physical seal bytes before UTF-8 decoding can replace damaged sequences", async () => {
    const s = setup(), file = s.source.files[0]!, frame = JSON.parse(file.data) as { rows: { text: string }[][] };
    frame.rows[0]![0]!.text += "\ufffd"; file.data = JSON.stringify(frame); file.byteLength = String(Buffer.byteLength(file.data)); file.sha256 = createHash("sha256").update(file.data).digest("hex");
    s.loseUpload(); expect((await s.open().advance(s.record, () => s.source)).state).toBe("pending");
    const seal = path.join(s.directory, `${s.record.sessionId}.archive-seal.json`), bytes = readFileSync(seal), index = bytes.indexOf(Buffer.from("\ufffd")); expect(index).toBeGreaterThan(0);
    writeFileSync(seal, Buffer.concat([bytes.subarray(0, index), Buffer.from([255]), bytes.subarray(index + 3)]));
    s.time(5000); expect((await s.open().advance(s.record, () => s.source)).state).toBe("failed");
  });
  it("accounts for fixed and interrupted seal bytes and deletes them only under original disposal intent", async () => {
    const s = setup(), archive = s.open(); s.api.upload = async () => { throw new Error("offline before upload"); };
    expect((await archive.advance(s.record, () => s.source)).state).toBe("pending");
    const seal = path.join(s.directory, `${s.record.sessionId}.archive-seal.json`), extra = `${seal}.${id(88)}.tmp`;
    writeFileSync(extra, "interrupted-private-screen");
    expect(BigInt(archive.storageBytes(s.record))).toBeGreaterThan(BigInt(readFileSync(seal).length + 24));
    expect(() => archive.removeSourceData(s.record)).toThrow();
    archive.disposition(s.record, { operationId: id(87), action: "delete", phase: "intent" });
    const operation = createOperation(); let checks = 0;
    try { expect(() => archive.removeSourceData(s.record, { ...operation, check: () => { operation.check(); if (++checks === 2) throw new Error("interrupted source deletion"); } })).toThrow("interrupted source deletion"); }
    finally { operation.dispose(); }
    expect(archive.inspect(s.record)?.disposition?.phase).toBe("intent");
    archive.removeSourceData(s.record);
    expect(() => readFileSync(seal)).toThrow(); expect(() => readFileSync(extra)).toThrow();
    expect(archive.inspect(s.record)?.disposition?.phase).toBe("intent");
    archive.removeSourceData(s.record); archive.disposition(s.record, { operationId: id(87), action: "delete", phase: "completed" });
    expect(archive.inspect(s.record)?.receipt).toBeNull();
  });
});
