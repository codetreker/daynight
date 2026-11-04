import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeDurableJson } from "../../controller/pending-content.js";
import { decodeSessionV2Archive, parseSessionV2Archive, verifySessionV2Archive } from "../../../session/v2/archive.js";
import { parseSessionV2Message, parseSessionV2Owner, parseSessionV2Runs, sessionV2ReceiptDigest, verifySessionV2Receipt } from "../../../session/v2/protocol.js";
import { canonicalSessionJson, decodeStrictSessionJson, exact, hash, integer, seq, SessionV2Error, SESSION_V2_PROTOCOL, uuid } from "../../../session/v2/values.js";
import type { SessionV2Archive, SessionV2Message, SessionV2Owner, SessionV2UnavailableRun } from "../../../session/v2/types.js";
import { HerdrArchiveHttpError, type HerdrArchiveApi, type HerdrArchiveIdentity } from "./archive-api.js";
import { HerdrSessionHttpError, type HerdrSessionState } from "./session-api.js";
import type { HerdrLifecycleRecord } from "./lifecycle-types.js";
import type { HerdrRecordingSnapshot } from "./recording-types.js";
import type { Operation } from "../../../api/operation.js";
import { ensureHerdrDurableDirectory, syncHerdrDirectory } from "./durable-directory.js";

type Message<K extends SessionV2Message["type"]> = Extract<SessionV2Message, { type: K }>;
export type HerdrArchiveDisposition = { operationId: string; action: "abandon" | "delete"; phase: "intent" | "completed"; at: number; sourceIdentity: string | null; archiveFiles: { name: string; identity: string }[] };
export type HerdrArchiveState = {
  schemaVersion: 1; owner: SessionV2Owner; sessionId: string; claimId: string;
  state: "pending" | "ready" | "unavailable" | "failed" | "permission_denied";
  failures: number; nextAttemptAt: number | null; error: string | null;
  finalization: Message<"finalization"> | null; evidence: Message<"recording_evidence">[];
  sourceSha256: string | null;
  seal: { sha256: string; byteLength: string; completeness: "complete" | "partial" } | null;
  unavailable: Message<"receipt"> | null; receipt: Message<"receipt"> | null;
  worktreeDeleted: boolean; disposition: HerdrArchiveDisposition | null; failurePublished: boolean;
};
const same = (left: unknown, right: unknown) => canonicalSessionJson(left) === canonicalSessionJson(right);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const corrupt = (message: string): never => { throw new HerdrArchiveSourceError(message); };
export class HerdrArchiveSourceError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "HerdrArchiveSourceError"; } }
const identity = (record: HerdrLifecycleRecord): HerdrArchiveIdentity => ({ owner: record.owner, sessionId: record.sessionId, claimId: record.claimId, executionGeneration: record.runs.at(-1)?.run.executionGeneration ?? "1" });
const envelope = (record: HerdrLifecycleRecord, generation = identity(record).executionGeneration) => ({ protocol: SESSION_V2_PROTOCOL, schemaVersion: 2 as const, projectionVersion: 1 as const, sessionId: record.sessionId, claimId: record.claimId, executionGeneration: generation, agentControlMode: "herdr" as const, contentKind: "terminal_recording" as const });
const stopped = (record: HerdrLifecycleRecord): void => {
  if (record.preparation !== null || record.runs.length === 0 || record.runs.some(run => run.phase !== "stopped_confirmed" || run.run.stopProof === null) || record.segments.some(segment => segment.endedAt === null)) throw new Error("Archive operations require the original confirmed stopped execution and closed segments.");
  parseSessionV2Runs(record.runs.map(value => value.run), identity(record).executionGeneration, true);
};
const assertSource = async (record: HerdrLifecycleRecord, source: HerdrRecordingSnapshot): Promise<void> => {
  if (source.schemaVersion !== 1 || source.sessionId !== record.sessionId || source.claimId !== record.claimId || !same(source.owner, record.owner) || !same(source.runs.map(run => run.executionGeneration), record.runs.map(run => run.run.executionGeneration))) corrupt("Recording source belongs to another original execution.");
  hash(source.journalSha256);
  if (!same(source.segments.map(segment => segment.segmentId), record.segments.map(segment => segment.segmentId))) corrupt("Recording segments differ from the original lifecycle ledger.");
  for (const run of source.runs) {
    const registered = record.runs.find(local => local.run.executionGeneration === run.executionGeneration)!.run;
    const count = source.files.filter(file => registered.segmentIds.includes(file.segmentId)).length;
    if (!run.closed || run.selectedFrameCount !== String(count) || run.registeredFrameCount !== String(count) || !run.recordingEnabled && count > 0) corrupt("Selected or registered recording content is missing.");
    if (run.captureError !== null && (run.captureError !== "recording_limit" || count === 0 || !source.gaps.some(gap => !("kind" in gap) && gap.reason === "recording_limit" && registered.segmentIds.includes(gap.segmentId)))) corrupt("The recording has a permanent capture failure.");
  }
};
const unavailableRuns = (record: HerdrLifecycleRecord, source: HerdrRecordingSnapshot): SessionV2UnavailableRun[] => source.runs.filter(run => !source.files.some(file => record.runs.find(value => value.run.executionGeneration === run.executionGeneration)!.run.segmentIds.includes(file.segmentId))).map(run => ({ executionGeneration: run.executionGeneration, reason: run.recordingEnabled ? "ended_before_first_sample" : "recording_not_enabled", evidence: { recordingEnabled: run.recordingEnabled, selectedFrameCount: "0", registeredFrameCount: "0", captureError: null } }));
const build = (record: HerdrLifecycleRecord, source: HerdrRecordingSnapshot, finalizationId: string): SessionV2Archive => parseSessionV2Archive({
  schemaVersion: 2, projectionVersion: 1, contentKind: "terminal_recording", agentControlMode: "herdr", sessionId: record.sessionId, claimId: record.claimId, executionGeneration: identity(record).executionGeneration,
  owner: record.owner, finalizationId,
  startedAt: record.runs.map(value => value.run.startedAt).reduce((left, right) => Date.parse(left) <= Date.parse(right) ? left : right),
  endedAt: record.runs.map(value => value.run.stoppedAt!).reduce((left, right) => Date.parse(left) >= Date.parse(right) ? left : right),
  completeness: source.gaps.length === 0 ? "complete" : "partial", policy: { sampleIntervalMs: 350, checkpointIntervalMs: 5000 }, runs: record.runs.map(run => run.run),
  segments: source.segments, files: source.files, index: source.index, gaps: source.gaps, unavailableRuns: unavailableRuns(record, source),
});

/** Fixed requests and receipts survive the Worker; the caller owns scheduling and native stop proof. */
export const createHerdrRecordingArchive = (options: { directory: string; api: HerdrArchiveApi; now?: () => number }) => {
  const now = options.now ?? Date.now, api = options.api;
  ensureHerdrDurableDirectory(options.directory);
  const file = (record: HerdrLifecycleRecord) => path.join(options.directory, `${uuid(record.sessionId)}.archive-state.json`);
  const sealFile = (record: HerdrLifecycleRecord) => path.join(options.directory, `${uuid(record.sessionId)}.archive-seal.json`);
  const entryIdentity = (stat: { dev: bigint; ino: bigint }) => `${stat.dev}:${stat.ino}`;
  const filePattern = (record: HerdrLifecycleRecord, dataOnly: boolean) => new RegExp(`^${uuid(record.sessionId)}\\.archive-${dataOnly ? "seal" : "(?:state|seal)"}\\.json(?:\\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.tmp)?$`);
  const ownedFiles = (record: HerdrLifecycleRecord, dataOnly: boolean) => {
    const root = lstatSync(options.directory, { bigint: true }); if (!root.isDirectory() || root.isSymbolicLink()) corrupt("The archive directory is not an original physical directory.");
    return readdirSync(options.directory).filter(name => filePattern(record, dataOnly).test(name)).sort().map(name => {
      const stat = lstatSync(path.join(options.directory, name), { bigint: true }); if (!stat.isFile() || stat.isSymbolicLink()) corrupt("The archive directory contains an unsafe original file.");
      return { name, identity: entryIdentity(stat), bytes: stat.size };
    });
  };
  const assertIdentity = (record: HerdrLifecycleRecord, state: HerdrArchiveState): void => {
    if (!same(state.owner, parseSessionV2Owner(record.owner)) || state.sessionId !== record.sessionId || state.claimId !== record.claimId) corrupt("Archive responsibility belongs to another original execution.");
    if (state.finalization && !same(state.finalization.payload.runs, record.runs.map(run => run.run))) corrupt("The original frozen run ledger changed.");
  };
  const inspect = (record: HerdrLifecycleRecord): HerdrArchiveState | null => {
    if (!existsSync(file(record))) return null;
    // A readable rename may have survived an earlier failed directory sync.
    // Re-establish durability before any receipt or disposal intent authorizes deletion.
    let raw: Buffer;
    try {
      const target = file(record), fd = openSync(target, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.size > 8n * 1024n * 1024n) corrupt("Invalid archive journal file.");
        raw = readFileSync(fd);
        fsyncSync(fd); syncHerdrDirectory(options.directory);
        const after = lstatSync(target, { bigint: true });
        if (!after.isFile() || after.isSymbolicLink() || entryIdentity(after) !== entryIdentity(before)) corrupt("The archive journal changed during durability observation.");
      } finally { closeSync(fd); }
    } catch (cause) { throw new JournalFailure("The archive journal durability is unconfirmed; preserve all resources.", { cause }); }
    const wrapper = exact(decodeStrictSessionJson(raw, 8 * 1024 * 1024), ["sha256", "state"]);
    if (hash(wrapper.sha256) !== digest(canonicalSessionJson(wrapper.state))) corrupt("The archive journal checksum is invalid.");
    const state = exact(wrapper.state, ["schemaVersion", "owner", "sessionId", "claimId", "state", "failures", "nextAttemptAt", "error", "finalization", "evidence", "sourceSha256", "seal", "unavailable", "receipt", "worktreeDeleted", "disposition", "failurePublished"]) as unknown as HerdrArchiveState;
    if (state.schemaVersion !== 1 || !["pending", "ready", "unavailable", "failed", "permission_denied"].includes(state.state) || typeof state.worktreeDeleted !== "boolean" || typeof state.failurePublished !== "boolean" || state.error !== null && typeof state.error !== "string") corrupt("Invalid archive journal state.");
    integer(state.failures, 0, Number.MAX_SAFE_INTEGER); if (state.nextAttemptAt !== null) integer(state.nextAttemptAt, 0, Number.MAX_SAFE_INTEGER);
    const check = (value: SessionV2Message | null, kind: SessionV2Message["type"]) => { if (value !== null) { const parsed = parseSessionV2Message(value); if (parsed.type !== kind || parsed.sessionId !== record.sessionId || parsed.claimId !== record.claimId) corrupt("The archive journal contains another operation."); } };
    check(state.finalization, "finalization"); check(state.unavailable, "receipt"); check(state.receipt, "receipt");
    if (!Array.isArray(state.evidence)) corrupt("Invalid recording evidence journal."); for (const message of state.evidence) check(message, "recording_evidence");
    if (state.sourceSha256 !== null) hash(state.sourceSha256);
    if (state.seal) { exact(state.seal, ["sha256", "byteLength", "completeness"]); hash(state.seal.sha256); seq(state.seal.byteLength); if (!["complete", "partial"].includes(state.seal.completeness)) corrupt("Invalid archive completeness."); }
    if (state.disposition) {
      exact(state.disposition, ["operationId", "action", "phase", "at", "sourceIdentity", "archiveFiles"]); uuid(state.disposition.operationId); integer(state.disposition.at, 0, Number.MAX_SAFE_INTEGER);
      if (state.disposition.sourceIdentity !== null && !/^\d+:\d+$/.test(state.disposition.sourceIdentity) || !["abandon", "delete"].includes(state.disposition.action) || !["intent", "completed"].includes(state.disposition.phase) || !Array.isArray(state.disposition.archiveFiles) || state.disposition.archiveFiles.length > 1000) corrupt("Invalid resource disposition.");
      for (const entry of state.disposition.archiveFiles) { exact(entry, ["name", "identity"]); if (!filePattern(record, true).test(entry.name) || !/^\d+:\d+$/.test(entry.identity)) corrupt("Invalid original archive source identity."); }
    }
    if ((state.state === "ready" || state.state === "unavailable") !== (state.receipt !== null) || state.worktreeDeleted && !state.receipt && state.disposition?.phase !== "completed") corrupt("Archive cleanup lacks a terminal receipt or explicit disposition.");
    assertIdentity(record, state); return state;
  };
  class JournalFailure extends Error {}
  const save = (record: HerdrLifecycleRecord, state: HerdrArchiveState): HerdrArchiveState => {
    assertIdentity(record, state);
    try { writeDurableJson(file(record), { sha256: digest(canonicalSessionJson(state)), state }); }
    catch (cause) {
      // Observe the exact bytes and repeat their durability barrier without replaying the write.
      try { if (same(inspect(record), state)) return state; } catch { /* No trustworthy durable outcome. */ }
      throw new JournalFailure("The archive journal write is unconfirmed; preserve all resources.", { cause });
    }
    return state;
  };
  const initial = (record: HerdrLifecycleRecord): HerdrArchiveState => ({ schemaVersion: 1, owner: record.owner, sessionId: record.sessionId, claimId: record.claimId, state: "pending", failures: 0, nextAttemptAt: now(), error: null, finalization: null, evidence: [], sourceSha256: null, seal: null, unavailable: null, receipt: null, worktreeDeleted: false, disposition: null, failurePublished: false });
  const verifyRemote = (record: HerdrLifecycleRecord, remote: HerdrSessionState): void => {
    if (remote.sessionId !== record.sessionId || remote.claimId !== record.claimId || !same(remote.owner, record.owner) || remote.executionGeneration !== identity(record).executionGeneration || !same(remote.ledger.runs, record.runs.map(run => run.run))) corrupt("The service ledger differs from the original stopped execution.");
  };
  const readSeal = async (record: HerdrLifecycleRecord, state: HerdrArchiveState): Promise<string> => {
    try {
      const bytes = readFileSync(sealFile(record));
      if (!state.seal || createHash("sha256").update(bytes).digest("hex") !== state.seal.sha256 || String(bytes.byteLength) !== state.seal.byteLength) corrupt("The fixed archive seal is missing or corrupt.");
      const doc = await decodeSessionV2Archive(bytes);
      if (doc.finalizationId !== state.finalization?.payload.finalizationId || !same(doc.owner, record.owner) || doc.sessionId !== record.sessionId || doc.claimId !== record.claimId || !same(doc.runs, record.runs.map(run => run.run)) || doc.completeness !== state.seal!.completeness) corrupt("The fixed archive seal belongs to another execution.");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) { throw new HerdrArchiveSourceError("The fixed archive seal cannot be verified.", { cause }); }
  };
  const acceptReceipt = async (record: HerdrLifecycleRecord, state: HerdrArchiveState, receipt: Message<"receipt">): Promise<HerdrArchiveState> => {
    parseSessionV2Message(receipt); await verifySessionV2Receipt(receipt);
    if (receipt.sessionId !== record.sessionId || receipt.claimId !== record.claimId || receipt.executionGeneration !== identity(record).executionGeneration || receipt.payload.finalizationId !== state.finalization?.payload.finalizationId) corrupt("The receipt belongs to another finalization.");
    if (state.seal) {
      if (receipt.payload.disposition !== "ready" || receipt.payload.sha256 !== state.seal.sha256 || receipt.payload.byteLength !== state.seal.byteLength || receipt.payload.completeness !== state.seal.completeness) corrupt("The receipt differs from the fixed archive content.");
    } else if (!state.unavailable || !same(receipt, state.unavailable)) corrupt("The unavailable receipt differs from the original zero-frame evidence.");
    state.receipt = receipt; state.state = receipt.payload.disposition; state.nextAttemptAt = null; state.error = null; return save(record, state);
  };
  const publishFailure = async (record: HerdrLifecycleRecord, state: HerdrArchiveState, signal?: AbortSignal): Promise<HerdrArchiveState> => {
    if (state.failurePublished) return state;
    try {
      const observed = await api.state(identity(record), signal); verifyRemote(record, observed);
      if (["ready", "unavailable"].includes(observed.archive.state)) { state.nextAttemptAt = null; return save(record, state); }
      if (observed.archive.state !== "failed") {
        const message: Message<"archive_status"> = { ...envelope(record), type: "archive_status", payload: { state: "failed", sha256: null, byteLength: null, completeness: null, errorCode: "source_corrupt", finalizationId: observed.ledger.finalizationId } };
        await api.failed(identity(record), message, signal);
      }
      const after = await api.state(identity(record), signal); verifyRemote(record, after);
      state.failurePublished = after.archive.state === "failed";
      state.nextAttemptAt = state.failurePublished ? null : now() + 5000;
    } catch (cause) {
      if (signal?.aborted || cause instanceof JournalFailure) throw cause;
      const denied = (cause instanceof HerdrArchiveHttpError || cause instanceof HerdrSessionHttpError) && [401, 403].includes(cause.status);
      state.nextAttemptAt = denied || cause instanceof HerdrArchiveSourceError ? null : now() + Math.min(5000 * 2 ** Math.min(state.failures - 1, 6), 300000);
    }
    return save(record, state);
  };
  const advance = async (record: HerdrLifecycleRecord, readSource: () => HerdrRecordingSnapshot | Promise<HerdrRecordingSnapshot>, signal?: AbortSignal): Promise<HerdrArchiveState> => {
    stopped(record); let state = inspect(record) ?? save(record, initial(record));
    if (state.receipt || state.disposition || state.nextAttemptAt !== null && now() < state.nextAttemptAt) return state;
    if (state.state === "failed") return state.nextAttemptAt === null ? state : publishFailure(record, state, signal);
    if (state.state !== "pending") return state;
    try {
      signal?.throwIfAborted();
      let remote = await api.state(identity(record), signal); verifyRemote(record, remote);
      if (remote.archive.state === "failed") corrupt(`The service permanently rejected this archive: ${remote.archive.errorCode ?? "source_corrupt"}.`);
      if (remote.ledger.finalizationId !== null && remote.ledger.finalizationId !== state.finalization?.payload.finalizationId) corrupt("The service froze an unrecorded finalization decision.");
      if (state.seal !== null) await readSeal(record, state);
      if (remote.archive.state === "ready" || remote.archive.state === "unavailable") return await acceptReceipt(record, state, await api.receipt(identity(record), signal));
      if (state.seal === null && state.unavailable === null) {
        let source: HerdrRecordingSnapshot;
        try { source = await readSource(); await assertSource(record, source); }
        catch (cause) { throw new HerdrArchiveSourceError("The registered recording source cannot be verified.", { cause }); }
        const fingerprint = digest(canonicalSessionJson(source));
        if (state.sourceSha256 !== null && state.sourceSha256 !== fingerprint) corrupt("The closed recording source changed after archival began.");
        if (state.finalization === null) {
          state.finalization = { ...envelope(record), type: "finalization", payload: { finalizationId: randomUUID(), claimTerminal: true, runs: record.runs.map(run => run.run) } };
          state.sourceSha256 = fingerprint;
          for (const run of source.runs) {
            const previous = remote.recording.find(value => value.executionGeneration === run.executionGeneration);
            if (!previous?.responsibility || previous.responsibility.responsibilityId !== run.responsibilityId || previous.responsibility.recordingEnabled !== run.recordingEnabled) corrupt("The original recording responsibility is missing or differs; legacy absence is not zero-frame evidence.");
            const ids = new Set(record.runs.find(value => value.run.executionGeneration === run.executionGeneration)!.run.segmentIds);
            const sourceHash = digest(canonicalSessionJson({ files: source.files.filter(value => ids.has(value.segmentId)), index: source.index.filter(value => ids.has(value.segmentId)) }));
            const payload: Message<"recording_evidence">["payload"] = { responsibilityId: run.responsibilityId, evidenceId: randomUUID(), revision: String(BigInt(previous!.evidence?.revision ?? "0") + 1n), selectedFrameCount: run.selectedFrameCount, registeredFrameCount: run.registeredFrameCount, captureError: run.captureError, closed: true, journalSha256: source.journalSha256, sourceSha256: sourceHash };
            if (previous!.evidence?.closed) {
              const prior = previous!.evidence;
              if (!same({ ...payload, evidenceId: prior.evidenceId, revision: prior.revision }, prior)) corrupt("The closed remote recording evidence differs from the local source.");
              payload.evidenceId = prior.evidenceId; payload.revision = prior.revision;
            }
            state.evidence.push({ ...envelope(record, run.executionGeneration), type: "recording_evidence", payload });
          }
          if (source.files.length > 0) await verifySessionV2Archive(build(record, source, state.finalization.payload.finalizationId));
          state = save(record, state);
        }
        for (const message of state.evidence) {
          const previous = remote.recording.find(value => value.executionGeneration === message.executionGeneration)?.evidence;
          if (same(previous ?? null, message.payload)) continue;
          if (previous?.closed) corrupt("The original closed evidence changed.");
          await api.recording({ ...identity(record), executionGeneration: message.executionGeneration }, message, remote.connectionEpoch, signal);
        }
        // Read after evidence writes and before freezing; a competing recovery changes this ledger.
        remote = await api.state(identity(record), signal); verifyRemote(record, remote);
        if (remote.ledger.finalizationId === null) await api.finalize(identity(record), state.finalization!, remote.connectionEpoch, signal);
        else if (remote.ledger.finalizationId !== state.finalization!.payload.finalizationId) corrupt("The finalization race selected another identity.");
        remote = await api.state(identity(record), signal); verifyRemote(record, remote);
        if (remote.ledger.finalizationId !== state.finalization!.payload.finalizationId) throw new Error("The original finalization is not yet confirmed.");
        if (source.files.length === 0) {
          const enabled = source.runs.some(run => run.recordingEnabled);
          const unavailable: Message<"receipt"> = { ...envelope(record), type: "receipt", payload: { finalizationId: state.finalization!.payload.finalizationId, disposition: "unavailable", dispositionDigest: "0".repeat(64), reason: enabled ? "ended_before_first_sample" : "recording_not_enabled", sha256: null, byteLength: null, completeness: null, evidence: { recordingEnabled: enabled, selectedFrameCount: "0", registeredFrameCount: "0", captureError: null } } };
          unavailable.payload.dispositionDigest = await sessionV2ReceiptDigest(unavailable); state.unavailable = unavailable; state = save(record, state);
        } else {
          const doc = build(record, source, state.finalization!.payload.finalizationId), body = canonicalSessionJson(doc);
          // A seal file without its journal entry is an orphan; validate its exact bytes before adoption.
          if (existsSync(sealFile(record))) { if (!readFileSync(sealFile(record)).equals(Buffer.from(body))) corrupt("An interrupted seal conflicts with the original content."); }
          else {
            const temporary = `${sealFile(record)}.${randomUUID()}.tmp`, fd = openSync(temporary, "wx", 0o600);
            try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
            renameSync(temporary, sealFile(record));
            syncHerdrDirectory(options.directory);
          }
          state.seal = { sha256: digest(body), byteLength: String(Buffer.byteLength(body)), completeness: doc.completeness }; state = save(record, state);
        }
      }
      const receipt = state.seal ? await api.upload(identity(record), await readSeal(record, state), signal) : await api.unavailable(identity(record), state.unavailable!, signal);
      // The PUT response is integrity-checked, then the immutable service record is independently observed.
      await verifySessionV2Receipt(receipt);
      return await acceptReceipt(record, state, await api.receipt(identity(record), signal));
    } catch (cause) {
      if (signal?.aborted || cause instanceof JournalFailure) throw cause;
      const denied = (cause instanceof HerdrArchiveHttpError || cause instanceof HerdrSessionHttpError) && [401, 403].includes(cause.status);
      const diskFailure = cause instanceof Error && "code" in cause && typeof cause.code === "string" && ["ENOSPC", "EIO", "EACCES", "EROFS", "ENOENT"].includes(cause.code);
      const permanent = cause instanceof HerdrArchiveSourceError || cause instanceof SessionV2Error || diskFailure || cause instanceof HerdrArchiveHttpError && (cause.code === "source_corrupt" || cause.code === "invalid_payload" || cause.status === 400);
      state.state = denied ? "permission_denied" : permanent ? "failed" : "pending";
      state.failures++; state.error = cause instanceof Error ? cause.message : String(cause);
      state.nextAttemptAt = state.state === "pending" ? now() + Math.min(5000 * 2 ** Math.min(state.failures - 1, 6), 300000) : null;
      state = save(record, state);
      return state.state === "failed" ? publishFailure(record, state, signal) : state;
    }
  };
  return {
    inspect, advance,
    storageBytes: (record: HerdrLifecycleRecord): string => String(ownedFiles(record, false).reduce((total, entry) => total + entry.bytes, 0n)),
    removeSourceData: (record: HerdrLifecycleRecord, operation?: Operation): void => {
      stopped(record); const state = inspect(record), intent = state?.disposition;
      if (!intent || intent.action !== "delete") throw new Error("Archive source deletion requires its original explicit disposal intent.");
      const expected = new Map(intent.archiveFiles.map(entry => [entry.name, entry.identity]));
      const current = ownedFiles(record, true);
      if (current.some(entry => expected.get(entry.name) !== entry.identity)) throw new Error("The archive source files changed after the original disposal intent.");
      const root = lstatSync(options.directory, { bigint: true }), rootIdentity = entryIdentity(root);
      const fd = process.platform === "win32" ? null : openSync(options.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        for (const entry of current) {
          operation?.check();
          const parent = lstatSync(options.directory, { bigint: true });
          if (!parent.isDirectory() || parent.isSymbolicLink() || entryIdentity(parent) !== rootIdentity || fd !== null && entryIdentity(fstatSync(fd, { bigint: true })) !== rootIdentity) throw new Error("The archive source directory changed during disposal.");
          const target = path.join(options.directory, entry.name), actual = lstatSync(target, { bigint: true });
          if (!actual.isFile() || actual.isSymbolicLink() || entryIdentity(actual) !== entry.identity) throw new Error("An archive source file was replaced during disposal.");
          unlinkSync(target);
        }
        if (fd !== null) fsyncSync(fd);
      } finally { if (fd !== null) closeSync(fd); }
    },
    defer: (record: HerdrLifecycleRecord, cause: unknown): HerdrArchiveState => {
      stopped(record); const state = inspect(record) ?? initial(record);
      if (state.receipt || state.disposition || state.state === "failed") return state;
      const denied = (cause instanceof HerdrArchiveHttpError || cause instanceof HerdrSessionHttpError) && [401, 403].includes(cause.status);
      state.state = denied ? "permission_denied" : "pending"; state.failures++; state.error = cause instanceof Error ? cause.message : String(cause);
      state.nextAttemptAt = denied ? null : now() + Math.min(5000 * 2 ** Math.min(state.failures - 1, 6), 300000);
      return save(record, state);
    },
    retry: (record: HerdrLifecycleRecord): HerdrArchiveState => {
      stopped(record); const state = inspect(record); if (!state || state.receipt || state.disposition || state.state === "failed") throw new Error("Only a retained transient or authorization failure can be explicitly retried.");
      state.state = "pending"; state.nextAttemptAt = now(); state.error = null; return save(record, state);
    },
    cleaned: (record: HerdrLifecycleRecord): HerdrArchiveState => {
      stopped(record); const state = inspect(record); if (!state?.receipt) throw new Error("Automatic worktree cleanup requires a durable immutable terminal receipt.");
      state.worktreeDeleted = true; return save(record, state);
    },
    disposition: (record: HerdrLifecycleRecord, request: Omit<HerdrArchiveDisposition, "at" | "sourceIdentity" | "archiveFiles"> & { sourceIdentity?: string | null }): HerdrArchiveState => {
      stopped(record); uuid(request.operationId); const state = inspect(record) ?? initial(record);
      if (!["abandon", "delete"].includes(request.action) || !["intent", "completed"].includes(request.phase)) throw new Error("An explicit supported resource disposition is required.");
      if (state.receipt) throw new Error("Ready archives are not failed-resource disposal targets.");
      const previous = state.disposition;
      if (previous && (previous.operationId !== request.operationId || previous.action !== request.action || request.sourceIdentity !== undefined && request.sourceIdentity !== previous.sourceIdentity)) throw new Error("An original resource disposition is already recorded.");
      if (!previous && request.phase === "completed") throw new Error("Resource disposition must persist intent before changing files.");
      if (previous?.phase === "completed") return state;
      state.disposition = { ...request, sourceIdentity: previous?.sourceIdentity ?? request.sourceIdentity ?? null, archiveFiles: previous?.archiveFiles ?? ownedFiles(record, true).map(({ name, identity }) => ({ name, identity })), at: now() }; state.nextAttemptAt = null;
      if (request.phase === "completed" && request.action === "delete") state.worktreeDeleted = true;
      return save(record, state);
    },
  };
};
export type HerdrRecordingArchive = ReturnType<typeof createHerdrRecordingArchive>;
