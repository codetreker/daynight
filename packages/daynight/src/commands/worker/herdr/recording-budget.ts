import { canonicalSessionJson, SESSION_V2_LIMITS } from "../../../session/v2/values.js";
import type { SessionV2Gap, TerminalBinding } from "../../../session/v2/types.js";
import type { HerdrLifecycleRecord } from "./lifecycle-types.js";

const id = "00000000-0000-4000-8000-000000000000", sequence = "9223372036854775807", time = "9999-12-31T23:59:59.999Z";
// nativeText permits 256 UTF-8 bytes; quotes require the largest JSON expansion.
const native = '"'.repeat(256);
const binding: TerminalBinding = { instanceId: native, sessionId: native, workspaceId: native, paneId: native, terminalId: native, nativeSessionId: native };
const bytes = (value: unknown) => Buffer.byteLength(canonicalSessionJson(value));
const endpoint = { executionGeneration: sequence, segmentId: id };
const boundaryGap = { kind: "boundary", reason: "restart", from: endpoint, to: endpoint };
const intervalGap = { segmentId: id, reason: "read_interrupted", startElapsedMs: sequence, endElapsedMs: sequence };
const largestGap = bytes(boundaryGap) > bytes(intervalGap) ? boundaryGap : intervalGap;

/**
 * Serialize every known metadata field exactly. Unfinished fields use their v2
 * wire maxima: 1000 process identities, 256-byte native strings (including JSON
 * escaping), 19-digit clocks, and all remaining gap slots. A new native run is
 * admitted before its binding exists, so that one binding also uses wire maxima.
 */
export const herdrRecordingMetadataBudget = (record: HerdrLifecycleRecord, gaps: SessionV2Gap[], next: "segment" | "run"): number => {
  const localRuns = record.runs.map(local => ({ ...local, run: structuredClone(local.run) }));
  const generation = next === "run" ? String(localRuns.length + 1) : localRuns.at(-1)?.run.executionGeneration ?? "1";
  if (next === "run") localRuns.push({ run: { executionGeneration: generation, owner: record.owner, binding, startedAt: time, stoppedAt: null, stopProof: null, segmentIds: [] }, processes: [], daemon: null } as unknown as HerdrLifecycleRecord["runs"][number]);
  const runs = localRuns.map(local => {
    const run = local.run;
    if (run.stopProof !== null) return run;
    run.binding.nativeSessionId ??= native;
    const bootId = local.daemon?.bootId ?? native;
    const known = (local.processes ?? []).map(process => ({ role: process.role === "shell" ? "shell" : "agent", pid: process.pid, birthToken: process.birthToken, bootId: process.bootId }));
    const processes = [...known, ...Array.from({ length: Math.max(0, 1000 - known.length) }, () => ({ role: "agent", pid: 2147483647, birthToken: native, bootId }))];
    return { ...run, stoppedAt: time, stopProof: { recordId: id, executionGeneration: run.executionGeneration, binding: run.binding, bootId, stoppedAt: time, method: "instances_exited", terminalStopped: true, processes } };
  });
  const current = runs.at(-1)!;
  const segments = record.segments.map(({ gap: _gap, ...segment }) => {
    const value = structuredClone(segment);
    if (localRuns.find(local => local.run.executionGeneration === value.executionGeneration)?.run.stopProof === null) value.binding.nativeSessionId ??= native;
    value.endedAt ??= time; value.durationMs ??= sequence; return value;
  });
  segments.push({ segmentId: id, segmentOrdinal: sequence, executionGeneration: generation, binding: structuredClone(current.binding), startedAt: time, endedAt: time, durationMs: sequence });
  current.segmentIds.push(id);
  const reservedGaps = gaps.map(gap => "kind" in gap ? gap : { ...gap, endElapsedMs: gap.endElapsedMs ?? sequence });
  const unavailableRuns = runs.map(run => ({ executionGeneration: run.executionGeneration, reason: "ended_before_first_sample", evidence: { recordingEnabled: false, selectedFrameCount: "0", registeredFrameCount: "0", captureError: null } }));
  const metadata = { schemaVersion: 2, projectionVersion: 1, contentKind: "terminal_recording", agentControlMode: "herdr", sessionId: record.sessionId, claimId: record.claimId, executionGeneration: generation, owner: record.owner, finalizationId: id, startedAt: time, endedAt: time, completeness: "complete", policy: { sampleIntervalMs: 350, checkpointIntervalMs: 5000 }, runs, segments, gaps: reservedGaps, unavailableRuns, files: [], index: [] };
  // Each added gap contributes its exact serialization plus the array separator.
  const futureGaps = Math.max(0, SESSION_V2_LIMITS.maxGaps - reservedGaps.length);
  return bytes(metadata) - bytes({ files: [], index: [] }) + futureGaps * (bytes(largestGap) + 1) - (reservedGaps.length === 0 && futureGaps > 0 ? 1 : 0);
};
