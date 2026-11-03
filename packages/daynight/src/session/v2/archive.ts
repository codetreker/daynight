import { assertNativeSessionIdProgression, assertTerminalBinding, parseSessionV2Owner, parseSessionV2Runs, parseSessionV2UnavailableEvidence, parseTerminalBinding, parseTerminalFrame } from "./protocol.js";
import { SESSION_V2_LIMITS, byteLength, canonicalSessionJson, choice, decodeStrictSessionJson, exact, fail, hash, hashSessionBytes, list, literal, nullable, seq, text, timestamp, unique, utf8, uuid } from "./values.js";
import type { SessionV2Archive, SessionV2BoundaryGap, SessionV2BoundaryEndpoint, SessionV2IntervalGap, SessionV2UnavailableRun, SessionV2FrameFile, SessionV2FrameIndex, SessionV2Gap, SessionV2Segment, TerminalFrame } from "./types.js";
export type { SessionV2Archive, SessionV2BoundaryGap, SessionV2BoundaryEndpoint, SessionV2IntervalGap, SessionV2UnavailableRun, SessionV2FrameFile, SessionV2FrameIndex, SessionV2Gap, SessionV2Segment } from "./types.js";
const inRange = (value: string, start: string, end: string): boolean => Date.parse(value) >= Date.parse(start) && Date.parse(value) <= Date.parse(end);
const parseSegment = (value: unknown): SessionV2Segment => {
  const o = exact(value, ["segmentId", "segmentOrdinal", "executionGeneration", "binding", "startedAt", "endedAt", "durationMs"]);
  return { segmentId: uuid(o.segmentId), segmentOrdinal: seq(o.segmentOrdinal), executionGeneration: seq(o.executionGeneration), binding: parseTerminalBinding(o.binding), startedAt: timestamp(o.startedAt), endedAt: timestamp(o.endedAt), durationMs: seq(o.durationMs, true) };
};
const parseFile = (value: unknown): SessionV2FrameFile => {
  const o = exact(value, ["fileId", "segmentId", "frameSeq", "sha256", "byteLength", "data"]);
  return { fileId: uuid(o.fileId), segmentId: uuid(o.segmentId), frameSeq: seq(o.frameSeq), sha256: hash(o.sha256), byteLength: byteLength(o.byteLength, SESSION_V2_LIMITS.frameMaxBytes), data: text(o.data, SESSION_V2_LIMITS.frameMaxBytes) };
};
const parseIndex = (value: unknown): SessionV2FrameIndex => {
  const o = exact(value, ["segmentId", "frameSeq", "fileId", "firstElapsedMs", "lastElapsedMs"]);
  return { segmentId: uuid(o.segmentId), frameSeq: seq(o.frameSeq), fileId: uuid(o.fileId), firstElapsedMs: seq(o.firstElapsedMs, true), lastElapsedMs: seq(o.lastElapsedMs, true) };
};
const parseEndpoint = (value: unknown): SessionV2BoundaryEndpoint => {
  const o = exact(value, ["executionGeneration", "segmentId"]);
  return { executionGeneration: seq(o.executionGeneration), segmentId: nullable(o.segmentId, uuid) };
};
const parseGap = (value: unknown): SessionV2Gap => {
  if (value && typeof value === "object" && Object.hasOwn(value, "kind")) {
    const o = exact(value, ["kind", "reason", "from", "to"]);
    return { kind: literal(o.kind, "boundary"), reason: literal(o.reason, "restart"), from: parseEndpoint(o.from), to: parseEndpoint(o.to) };
  }
  const o = exact(value, ["segmentId", "reason", "startElapsedMs", "endElapsedMs"]);
  return { segmentId: uuid(o.segmentId), reason: choice(o.reason, ["restart", "read_interrupted", "recording_limit", "checkpoint_lost"]), startElapsedMs: seq(o.startElapsedMs, true), endElapsedMs: nullable(o.endElapsedMs, value => seq(value, true)) };
};
const parseUnavailableRun = (value: unknown): SessionV2UnavailableRun => {
  const o = exact(value, ["executionGeneration", "reason", "evidence"]), reason = choice(o.reason, ["recording_not_enabled", "ended_before_first_sample"]);
  return { executionGeneration: seq(o.executionGeneration), reason, evidence: parseSessionV2UnavailableEvidence(o.evidence, reason) };
};
/** Validates all references and decoded frames; call the byte decoder to also verify hashes. */
export const parseSessionV2Archive = (value: unknown): SessionV2Archive => {
  const o = exact(value, ["schemaVersion", "projectionVersion", "contentKind", "agentControlMode", "sessionId", "claimId", "executionGeneration", "owner", "finalizationId", "startedAt", "endedAt", "completeness", "policy", "runs", "segments", "files", "index", "gaps", "unavailableRuns"]);
  if (o.schemaVersion !== 2 || o.projectionVersion !== 1) return fail("unsupported_protocol");
  if (o.contentKind !== "terminal_recording" || o.agentControlMode !== "herdr") return fail("unsupported_content_kind");
  const policy = exact(o.policy, ["sampleIntervalMs", "checkpointIntervalMs"]), generation = seq(o.executionGeneration);
  const archive: SessionV2Archive = { schemaVersion: 2, projectionVersion: 1, contentKind: "terminal_recording", agentControlMode: "herdr", sessionId: uuid(o.sessionId), claimId: uuid(o.claimId), executionGeneration: generation, owner: parseSessionV2Owner(o.owner), finalizationId: uuid(o.finalizationId), startedAt: timestamp(o.startedAt), endedAt: timestamp(o.endedAt), completeness: choice(o.completeness, ["complete", "partial"]), policy: { sampleIntervalMs: literal(policy.sampleIntervalMs, 350), checkpointIntervalMs: literal(policy.checkpointIntervalMs, 5000) }, runs: parseSessionV2Runs(o.runs, generation, true), segments: unique(list(o.segments, parseSegment, SESSION_V2_LIMITS.maxSegments, 1), s => s.segmentId), files: unique(list(o.files, parseFile, SESSION_V2_LIMITS.maxFrames, 1), f => f.fileId), index: unique(list(o.index, parseIndex, SESSION_V2_LIMITS.maxFrames, 1), f => f.fileId), gaps: list(o.gaps, parseGap, SESSION_V2_LIMITS.maxGaps), unavailableRuns: unique(list(o.unavailableRuns, parseUnavailableRun, SESSION_V2_LIMITS.maxRuns), r => r.executionGeneration) };
  if (Date.parse(archive.endedAt) < Date.parse(archive.startedAt) || canonicalSessionJson(archive.owner) !== canonicalSessionJson(archive.runs[0]!.owner) || (archive.completeness === "partial") !== (archive.gaps.length > 0)) return fail("source_corrupt");
  const segments = new Map(archive.segments.map(s => [s.segmentId, s])), files = new Map(archive.files.map(f => [f.fileId, f]));
  let ordinal = 0n, segmentGeneration = 0n;
  for (const segment of archive.segments) {
    const run = archive.runs.find(r => r.executionGeneration === segment.executionGeneration);
    if (!run || BigInt(segment.executionGeneration) < segmentGeneration || BigInt(segment.segmentOrdinal) <= ordinal || !run.segmentIds.includes(segment.segmentId) || !inRange(segment.startedAt, run.startedAt, run.stoppedAt!) || !inRange(segment.endedAt, segment.startedAt, run.stoppedAt!)) return fail("source_corrupt");
    assertTerminalBinding(run.binding, segment.binding); ordinal = BigInt(segment.segmentOrdinal); segmentGeneration = BigInt(segment.executionGeneration);
  }
  if (archive.segments[0]!.segmentOrdinal !== "1") return fail("source_corrupt");
  let nativeSession: string | null = null;
  for (const run of archive.runs) {
    assertNativeSessionIdProgression(nativeSession, run.binding.nativeSessionId); nativeSession = run.binding.nativeSessionId;
    for (const segment of archive.segments.filter(s => s.executionGeneration === run.executionGeneration)) {
      assertNativeSessionIdProgression(nativeSession, segment.binding.nativeSessionId); nativeSession = segment.binding.nativeSessionId;
    }
    assertNativeSessionIdProgression(nativeSession, run.stopProof!.binding.nativeSessionId); nativeSession = run.stopProof!.binding.nativeSessionId;
    if (!inRange(run.startedAt, archive.startedAt, archive.endedAt) || !inRange(run.stoppedAt!, archive.startedAt, archive.endedAt) || canonicalSessionJson(run.segmentIds) !== canonicalSessionJson(archive.segments.filter(s => s.executionGeneration === run.executionGeneration).map(s => s.segmentId))) return fail("source_corrupt");
  }
  const frames = new Map<string, TerminalFrame>();
  for (const file of archive.files) {
    const segment = segments.get(file.segmentId);
    if (!segment || String(utf8.encode(file.data).length) !== file.byteLength) return fail("source_corrupt");
    const frame = parseTerminalFrame(decodeStrictSessionJson(file.data, SESSION_V2_LIMITS.frameMaxBytes));
    if (frame.frameSeq !== file.frameSeq || !inRange(frame.capturedAt, segment.startedAt, segment.endedAt)) return fail("source_corrupt");
    frames.set(file.fileId, frame);
  }
  let previous: SessionV2FrameIndex | undefined;
  for (const entry of archive.index) {
    const segment = segments.get(entry.segmentId), file = files.get(entry.fileId), frame = frames.get(entry.fileId);
    if (!segment || !file || !frame || file.segmentId !== entry.segmentId || file.frameSeq !== entry.frameSeq || entry.firstElapsedMs !== frame.elapsedMs || BigInt(entry.lastElapsedMs) < BigInt(entry.firstElapsedMs) || BigInt(entry.lastElapsedMs) > BigInt(segment.durationMs)) return fail("source_corrupt");
    if (previous) {
      const previousOrdinal = BigInt(segments.get(previous.segmentId)!.segmentOrdinal), currentOrdinal = BigInt(segment.segmentOrdinal);
      if (currentOrdinal < previousOrdinal || currentOrdinal === previousOrdinal && (BigInt(entry.frameSeq) <= BigInt(previous.frameSeq) || BigInt(entry.firstElapsedMs) <= BigInt(previous.lastElapsedMs))) return fail("source_corrupt");
    }
    previous = entry;
  }
  if (archive.index.length !== archive.files.length) return fail("source_corrupt");
  const expectedBoundaries: SessionV2BoundaryGap[] = [];
  const endpoint = (executionGeneration: string, segmentId: string | null): SessionV2BoundaryEndpoint => ({ executionGeneration, segmentId });
  for (let i = 0; i < archive.runs.length; i++) {
    const run = archive.runs[i]!;
    for (let j = 1; j < run.segmentIds.length; j++) expectedBoundaries.push({ kind: "boundary", reason: "restart", from: endpoint(run.executionGeneration, run.segmentIds[j - 1]!), to: endpoint(run.executionGeneration, run.segmentIds[j]!) });
    const next = archive.runs[i + 1];
    if (next) expectedBoundaries.push({ kind: "boundary", reason: "restart", from: endpoint(run.executionGeneration, run.segmentIds.at(-1) ?? null), to: endpoint(next.executionGeneration, next.segmentIds[0] ?? null) });
  }
  const intervalGaps: SessionV2IntervalGap[] = [], boundaries: SessionV2BoundaryGap[] = [];
  for (const gap of archive.gaps) {
    if ("kind" in gap) boundaries.push(gap);
    else { if (boundaries.length) return fail(); intervalGaps.push(gap); }
  }
  if (canonicalSessionJson(boundaries) !== canonicalSessionJson(expectedBoundaries)) return fail();
  const recordedRuns = new Set(archive.files.map(file => segments.get(file.segmentId)!.executionGeneration));
  const emptyRuns = archive.runs.filter(run => !recordedRuns.has(run.executionGeneration)).map(run => run.executionGeneration);
  if (canonicalSessionJson(archive.unavailableRuns.map(run => run.executionGeneration)) !== canonicalSessionJson(emptyRuns)) return fail();
  let previousGap: SessionV2IntervalGap | undefined, gapFrameIndex = 0;
  for (const gap of intervalGaps) {
    const segment = segments.get(gap.segmentId); if (!segment) return fail("source_corrupt");
    if (!recordedRuns.has(segment.executionGeneration) && gap.reason !== "restart") return fail();
    const start = BigInt(gap.startElapsedMs), end = BigInt(gap.endElapsedMs ?? segment.durationMs);
    if (end < start || end > BigInt(segment.durationMs)) return fail("source_corrupt");
    if (previousGap) {
      const previousSegment = segments.get(previousGap.segmentId)!;
      if (BigInt(segment.segmentOrdinal) < BigInt(previousSegment.segmentOrdinal) || segment.segmentId === previousGap.segmentId && start <= BigInt(previousGap.endElapsedMs ?? previousSegment.durationMs)) return fail("source_corrupt");
    }
    // Both streams are sorted by segment ordinal and monotonic time. Sweep once
    // rather than rescanning up to 100000 frames for each of the 1000 gaps.
    while (gapFrameIndex < archive.index.length) {
      const entry = archive.index[gapFrameIndex]!, entryOrdinal = BigInt(segments.get(entry.segmentId)!.segmentOrdinal);
      if (entryOrdinal < BigInt(segment.segmentOrdinal) || entry.segmentId === gap.segmentId && BigInt(entry.lastElapsedMs) < start) gapFrameIndex++;
      else break;
    }
    const nextFrame = archive.index[gapFrameIndex];
    if (nextFrame?.segmentId === gap.segmentId && BigInt(nextFrame.firstElapsedMs) <= end) return fail("source_corrupt");
    previousGap = gap;
  }
  const recordingBytes = utf8.encode(canonicalSessionJson({ files: archive.files, index: archive.index })).length;
  const totalBytes = utf8.encode(canonicalSessionJson(archive)).length;
  if (recordingBytes > SESSION_V2_LIMITS.recordingMaxBytes || totalBytes - recordingBytes > SESSION_V2_LIMITS.metadataMaxBytes || totalBytes > SESSION_V2_LIMITS.archiveMaxBytes) return fail("recording_limit");
  return archive;
};
export const verifySessionV2Archive = async (archive: SessionV2Archive): Promise<void> => {
  for (const file of archive.files) if (await hashSessionBytes(file.data) !== file.sha256) return fail("source_corrupt");
};
export const decodeSessionV2Archive = async (input: string | Uint8Array): Promise<SessionV2Archive> => {
  const result = parseSessionV2Archive(decodeStrictSessionJson(input, SESSION_V2_LIMITS.archiveMaxBytes));
  await verifySessionV2Archive(result); return result;
};
