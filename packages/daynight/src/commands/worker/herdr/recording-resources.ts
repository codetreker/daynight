import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ApiError } from "../../../api/client.js";
import { cleanupOperation } from "../../cleanup-operation.js";
import type { Operation } from "../../../api/operation.js";
import { readWorkerClaim } from "../../../api/task-properties.js";
import type { WorkerRemote } from "../remote.js";
import type { ResourceOwner } from "../types.js";
import { assertHerdrDisposalTarget, removeHerdrSourceDirectory } from "../resource-disposal.js";
import { canonicalSessionJson, decodeStrictSessionJson, uuid } from "../../../session/v2/values.js";
import type { HerdrLifecycleRecord } from "./lifecycle-types.js";
import type { HerdrRecordingSnapshot } from "./recording-types.js";
import type { HerdrArchiveResources, HerdrRetainedResource, HerdrResourceTarget } from "./resource-types.js";
import type { HerdrArchiveState, HerdrRecordingArchive } from "./recording-archive.js";

const same = (left: unknown, right: unknown): boolean => canonicalSessionJson(left) === canonicalSessionJson(right);
const ownerOf = (record: HerdrLifecycleRecord): ResourceOwner => ({ projectId: record.owner.projectId, taskId: record.owner.taskId, claimId: record.claimId, worktreeId: record.owner.worktreeId });
const stopped = (record: HerdrLifecycleRecord): boolean => record.preparation === null && record.runs.length > 0 && record.runs.every(run => run.phase === "stopped_confirmed" && run.run.stopProof !== null) && record.segments.every(segment => segment.endedAt !== null);
const absent = (file: string): boolean => { try { lstatSync(file); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; } };
const sourceIdentity = (directory: string): string | null => {
  if (absent(directory)) return null;
  const stat = lstatSync(directory, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The recording source is not an original physical directory.");
  return `${stat.dev}:${stat.ino}`;
};
const sourceBytes = (directory: string): string => {
  if (absent(directory)) return "0";
  let bytes = 0n, entries = 0; const pending = [directory];
  while (pending.length > 0) {
    const file = pending.pop()!, stat = lstatSync(file, { bigint: true });
    if (++entries > 1_000_000 || stat.isSymbolicLink()) throw new Error("The source inventory is unsafe or exceeds its inspection bound.");
    if (stat.isDirectory()) for (const name of readdirSync(file)) pending.push(path.join(file, name));
    else if (stat.isFile()) bytes += stat.size;
    else throw new Error("The recording source contains an unsupported filesystem object.");
  }
  return String(bytes);
};
const assertSourceOwner = (directory: string, record: HerdrLifecycleRecord): void => {
  if (absent(directory)) return;
  sourceIdentity(directory);
  const file = path.join(directory, "manifest.json"), stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error("The recording source has no bounded original ownership manifest.");
  if (!same(decodeStrictSessionJson(readFileSync(file), 16_384), { schemaVersion: 1, owner: record.owner, sessionId: record.sessionId, claimId: record.claimId })) throw new Error("The recording source belongs to another original execution.");
};

/** Local resource management never changes remote archive history or grants native recovery. */
export const createHerdrRecordingResources = (options: {
  directory: string;
  archive: HerdrRecordingArchive;
  list(): HerdrLifecycleRecord[];
  get(owner: ResourceOwner): HerdrLifecycleRecord | null;
  source(record: HerdrLifecycleRecord): HerdrRecordingSnapshot;
  publishStopped(record: HerdrLifecycleRecord, operation: Operation): Promise<void>;
  readTask: WorkerRemote["readTask"];
  currentUserId?: WorkerRemote["currentUserId"];
}): HerdrArchiveResources => {
  if (!path.isAbsolute(options.directory)) throw new Error("Recording resources require an absolute original data root.");
  const sourcePath = (record: HerdrLifecycleRecord) => path.join(options.directory, uuid(record.sessionId));
  const get = (owner: ResourceOwner, sessionId?: string): HerdrLifecycleRecord => {
    const record = options.get(owner);
    if (!record || !same(ownerOf(record), { projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId, worktreeId: owner.worktreeId }) || sessionId !== undefined && record.sessionId !== sessionId) throw new Error("The resource identity differs from the original execution.");
    return record;
  };
  const inspect = (record: HerdrLifecycleRecord): HerdrRetainedResource => {
    let state: HerdrArchiveState | null = null, error: string | null = null, bytes = "unknown", sourceFailure = false, journalFailure = false;
    try { state = options.archive.inspect(record); } catch (cause) { journalFailure = true; error = cause instanceof Error ? cause.message : String(cause); }
    const directory = sourcePath(record), deleted = state?.disposition?.action === "delete" && state.disposition.phase === "completed";
    try { bytes = String(BigInt(sourceBytes(directory)) + BigInt(options.archive.storageBytes(record))); }
    catch (cause) { sourceFailure = true; error ??= cause instanceof Error ? cause.message : String(cause); }
    if (!deleted) {
      try { if (absent(directory)) throw new Error("The registered recording source is missing; resources remain retained."); assertSourceOwner(directory, record); }
      catch (cause) { sourceFailure = true; error ??= cause instanceof Error ? cause.message : String(cause); }
    }
    const disposition = state?.disposition;
    return {
      owner: ownerOf(record), sessionId: record.sessionId, stopped: stopped(record),
      stopEvidence: record.runs.flatMap(run => run.run.stopProof ? [run.run.stopProof] : []),
      terminal: state !== null || record.runs.some(run => run.stopReason === "terminal"),
      worktreePath: record.cwd, sourcePath: directory, sourceBytes: bytes,
      state: disposition?.phase === "completed" ? "abandoned" : journalFailure || sourceFailure && !state?.receipt ? "failed" : state?.state ?? "pending",
      error: error ?? state?.error ?? null,
      nextAttemptAt: journalFailure ? null : state?.nextAttemptAt ?? (sourceFailure && !state ? 0 : null),
      worktreeDeleted: state?.worktreeDeleted ?? false,
      disposition: disposition ? { operationId: disposition.operationId, action: disposition.action, completed: disposition.phase === "completed" } : null,
    };
  };
  const terminal = async (record: HerdrLifecycleRecord, operation: Operation): Promise<void> => {
    operation.check();
    try {
      const task = await options.readTask(record.owner.projectId, record.owner.taskId, operation.signal);
      if (task.id !== record.owner.taskId || task.projectId !== record.owner.projectId) throw new Error("The task observation belongs to another resource owner.");
      const claim = readWorkerClaim(task.properties);
      if (claim?.claimId === record.claimId && claim.state === "active") throw new Error("The original claim is still active; archive finalization or disposal is prohibited.");
    } catch (cause) {
      // Task reads hide missing project access behind 404. Only the original
      // task's explicit tombstone can replace an authorized task observation.
      if (!(cause instanceof ApiError) || cause.phase !== "response" || cause.status !== 410 || cause.code !== "task_deleted"
        || cause.projectId !== record.owner.projectId || cause.taskId !== record.owner.taskId || cause.outcomeUnconfirmed) throw cause;
    }
    if (!stopped(record)) throw new Error("The original native execution stop is not confirmed.");
  };
  const authorize = async (target: HerdrResourceTarget, operation: Operation): Promise<HerdrLifecycleRecord> => {
    const record = get(target, target.sessionId); operation.check();
    if (!options.currentUserId || await options.currentUserId(operation.signal) !== record.owner.ownerUserId) throw new Error("Resource management requires the original authenticated execution owner.");
    await terminal(record, operation); return get(target, target.sessionId);
  };
  const advance = async (owner: ResourceOwner, operation: Operation): Promise<boolean> => {
    let record = get(owner); await terminal(record, operation);
    const previous = options.archive.inspect(record);
    // Frozen Sessions reject ordinary ledger publication. Resume the exact
    // archive decision directly after its first stopped-ledger confirmation.
    if (!previous?.finalization && previous?.state !== "failed") {
      try { await options.publishStopped(record, operation); }
      catch (cause) { operation.check(); options.archive.defer(record, cause); return false; }
    }
    record = get(owner); operation.check();
    const state = await options.archive.advance(record, () => options.source(record), operation.signal);
    return state.receipt !== null && (state.state === "ready" || state.state === "unavailable");
  };
  return {
    resources: () => options.list().map(inspect),
    advance,
    cleaned: owner => { const record = get(owner); if (!absent(record.cwd)) throw new Error("The original worktree is still present; cleanup cannot be recorded."); options.archive.cleaned(record); },
    retry: async (target, operation) => { const record = await authorize(target, operation); options.archive.retry(record); await advance(target, operation); return inspect(get(target, target.sessionId)); },
    dispose: async (request, operation, removeWorktree, scope) => {
      const signal = scope === undefined ? operation.signal : scope.signal;
      const record = await authorize(request, operation), resource = { ...inspect(record), terminal: true };
      assertHerdrDisposalTarget(resource, request);
      const previous = options.archive.inspect(record)?.disposition;
      if (previous?.phase === "completed") return resource;
      const directory = sourcePath(record), currentIdentity = sourceIdentity(directory);
      if (previous) {
        if (currentIdentity !== null && currentIdentity !== previous.sourceIdentity) throw new Error("The recording source directory was replaced after the original disposal intent.");
      } else assertSourceOwner(directory, record);
      options.archive.disposition(record, { operationId: request.operationId, action: request.action, phase: "intent", sourceIdentity: previous?.sourceIdentity ?? currentIdentity });
      if (request.action === "delete") {
        operation.check(); await removeWorktree();
        await cleanupOperation(async sourceOperation => {
          sourceOperation.check();
          if (!absent(record.cwd)) throw new Error("The original worktree removal was not confirmed.");
          if (sourceIdentity(directory) !== currentIdentity) throw new Error("The recording source changed during worktree disposal.");
          await removeHerdrSourceDirectory(options.directory, directory, sourceOperation);
          if (!absent(directory)) throw new Error("The recording source removal was not confirmed.");
          options.archive.removeSourceData(record, sourceOperation);
          sourceOperation.check();
        }, signal);
      }
      signal?.throwIfAborted();
      options.archive.disposition(record, { operationId: request.operationId, action: request.action, phase: "completed" });
      return inspect(get(request, request.sessionId));
    },
  };
};
