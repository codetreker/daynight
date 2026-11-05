import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertTerminalBinding, parseSessionV2Owner, parseTerminalBinding, parseTerminalFrame } from "../../../session/v2/protocol.js";
import { canonicalSessionJson, decodeStrictSessionJson, seq, timestamp, uuid, SESSION_V2_LIMITS, SessionV2Error } from "../../../session/v2/values.js";
import type { SessionV2FrameFile, SessionV2FrameIndex, SessionV2Gap, SessionV2IntervalGap, SessionV2Segment, TerminalBinding, TerminalFrame } from "../../../session/v2/types.js";
import { ensureHerdrDurableDirectory, syncHerdrDirectory } from "./durable-directory.js";
import type { HerdrLocalSegment } from "./lifecycle-types.js";
import type { HerdrRecordingBoundary, HerdrRecordingIdentity, HerdrRecordingObservation, HerdrRecordingRun, HerdrRecordingScreen, HerdrRecordingSnapshot } from "./recording-types.js";

type FileRecord = Omit<SessionV2FrameFile, "data">;
type Selected = { file: FileRecord; index: SessionV2FrameIndex; screenHash: string; capturedAt: string };
type SegmentState = { segment: HerdrLocalSegment; durableElapsed: string; durableCapturedAt: string; coverageBoundary: HerdrRecordingBoundary | null; lastFile: string | null; screenHash: string | null };
type Event =
  | { type: "run"; run: HerdrRecordingRun }
  | { type: "segment"; segment: HerdrLocalSegment }
  | { type: "binding"; executionGeneration: string; binding: TerminalBinding }
  | { type: "select"; selected: Selected }
  | { type: "register"; fileId: string }
  | { type: "checkpoint"; fileId: string; elapsedMs: string; capturedAt: string }
  | { type: "gap"; gap: SessionV2IntervalGap; capturedAt: string }
  | { type: "gap_end"; segmentId: string; endElapsedMs: string }
  | { type: "gap_limit"; segmentId: string }
  | { type: "segment_end"; segmentId: string; boundary: HerdrRecordingBoundary }
  | { type: "error"; executionGeneration: string; code: "source_corrupt" | "recording_limit" }
  | { type: "run_end"; executionGeneration: string };
type JournalLine = { revision: string; previous: string; event: Event; sha256: string };
const digest = (body: string | Uint8Array): string => createHash("sha256").update(body).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const same = (left: unknown, right: unknown): boolean => canonicalSessionJson(left) === canonicalSessionJson(right);
const corrupt = (): never => { throw new SessionV2Error("source_corrupt"); };
const safeFile = (file: string): void => { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) corrupt(); };
const durableFile = (file: string, data: string): void => {
  const temporary = `${file}.${randomUUID()}.tmp`, fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file); syncHerdrDirectory(path.dirname(file));
};
const bytes = (value: unknown): number => Buffer.byteLength(canonicalSessionJson(value));

/**
 * Append-only, hash-linked index. Selection commits before file creation; file
 * fsync/rename commits before registration. A failed append never makes a frame
 * recorded. Recovery adopts only a file matching its original selected intent.
 */
export const openHerdrRecordingStore = (options: HerdrRecordingIdentity & { directory: string }) => {
  if (!path.isAbsolute(options.directory)) throw new Error("Recording directory must be absolute.");
  const identity: HerdrRecordingIdentity = { owner: parseSessionV2Owner(options.owner), sessionId: uuid(options.sessionId), claimId: uuid(options.claimId) };
  const directory = options.directory, manifest = path.join(directory, "manifest.json"), journal = path.join(directory, "journal.jsonl"), framesDirectory = path.join(directory, "frames");
  const existed = existsSync(directory);
  if (existed && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) corrupt();
  ensureHerdrDurableDirectory(directory);
  const header = { schemaVersion: 1, ...identity };
  if (existsSync(manifest)) { safeFile(manifest); if (!same(decodeStrictSessionJson(readFileSync(manifest), 16_384), header)) corrupt(); }
  else {
    if (readdirSync(directory).length !== 0) corrupt();
    durableFile(manifest, canonicalSessionJson(header));
    ensureHerdrDurableDirectory(framesDirectory); durableFile(journal, ""); syncHerdrDirectory(directory);
  }
  if (!existsSync(journal) || !existsSync(framesDirectory) || !lstatSync(framesDirectory).isDirectory() || lstatSync(framesDirectory).isSymbolicLink()) corrupt();
  safeFile(journal);
  const journalIdentity = lstatSync(journal); let journalLength = journalIdentity.size;
  const runs = new Map<string, HerdrRecordingRun>(), segments = new Map<string, SegmentState>();
  const selected = new Map<string, Selected>(), files = new Map<string, FileRecord>(), indexes = new Map<string, SessionV2FrameIndex>();
  const gaps: SessionV2Gap[] = [], pending = new Map<string, HerdrRecordingObservation>(), liveSequences = new Map<string, bigint>();
  let revision = 0n, chain = digest(canonicalSessionJson(header)), recordingBytes = bytes({ files: [], index: [] }), failed = false;
  const runFor = (segmentId: string): HerdrRecordingRun => { const segment = segments.get(segmentId); return segment ? runs.get(segment.segment.executionGeneration) ?? corrupt() : corrupt(); };
  const segmentFor = (segmentId: string): SegmentState => segments.get(segmentId) ?? corrupt();
  const cover = (s: SegmentState, durationMs: string, capturedAt?: string): void => {
    const prior = s.coverageBoundary;
    // Frames and gaps both bound the committed timeline, but only frames extend
    // frame indexes. A gap_end has no wall-clock observation: retain the latest
    // committed timestamp instead of deriving one from its monotonic duration.
    s.coverageBoundary = {
      durationMs: prior && BigInt(prior.durationMs) > BigInt(durationMs) ? prior.durationMs : durationMs,
      endedAt: capturedAt && (!prior || Date.parse(capturedAt) > Date.parse(prior.endedAt)) ? capturedAt : prior?.endedAt ?? s.segment.startedAt,
    };
  };
  const apply = (event: Event): void => {
    if (event.type === "run") {
      const run = event.run;
      seq(run.executionGeneration); uuid(run.responsibilityId);
      if (runs.has(run.executionGeneration) || run.executionGeneration !== String(runs.size + 1) || typeof run.recordingEnabled !== "boolean" || run.selectedFrameCount !== "0" || run.registeredFrameCount !== "0" || run.captureError !== null || run.closed !== false) corrupt();
      runs.set(run.executionGeneration, clone(run));
    } else if (event.type === "segment") {
      const s = event.segment, run = runs.get(s.executionGeneration);
      uuid(s.segmentId); seq(s.segmentOrdinal); timestamp(s.startedAt);
      if (!run || run.closed || segments.has(s.segmentId) || s.segmentOrdinal !== String(segments.size + 1) || s.endedAt !== null || s.durationMs !== null || [...segments.values()].some(value => value.segment.endedAt === null)) corrupt();
      segments.set(s.segmentId, { segment: clone(s), durableElapsed: "0", durableCapturedAt: s.startedAt, coverageBoundary: null, lastFile: null, screenHash: null });
      if (s.gap !== null) gaps.push(clone(s.gap));
    } else if (event.type === "binding") {
      const run = runs.get(event.executionGeneration) ?? corrupt(), binding = parseTerminalBinding(event.binding);
      if (run.closed) corrupt();
      for (const s of segments.values()) if (s.segment.executionGeneration === event.executionGeneration) {
        assertTerminalBinding(s.segment.binding, binding); s.segment.binding = clone(binding);
      }
    } else if (event.type === "select") {
      const choice = event.selected, s = segmentFor(choice.file.segmentId), run = runFor(choice.file.segmentId);
      uuid(choice.file.fileId); seq(choice.file.frameSeq); seq(choice.index.firstElapsedMs, true); timestamp(choice.capturedAt);
      if (selected.has(choice.file.fileId) || files.has(choice.file.fileId) || s.segment.endedAt !== null || run.closed || run.captureError !== null || !run.recordingEnabled || choice.index.fileId !== choice.file.fileId || choice.index.segmentId !== choice.file.segmentId || choice.index.frameSeq !== choice.file.frameSeq || choice.index.firstElapsedMs !== choice.index.lastElapsedMs) corrupt();
      const prior = s.lastFile === null ? null : indexes.get(s.lastFile)!;
      if (prior && (BigInt(choice.file.frameSeq) <= BigInt(prior.frameSeq) || BigInt(choice.index.firstElapsedMs) <= BigInt(prior.lastElapsedMs))) corrupt();
      selected.set(choice.file.fileId, clone(choice)); run.selectedFrameCount = String(BigInt(run.selectedFrameCount) + 1n);
    } else if (event.type === "register") {
      const choice = selected.get(event.fileId) ?? corrupt(), s = segmentFor(choice.file.segmentId), run = runFor(choice.file.segmentId);
      if (files.has(event.fileId)) corrupt();
      files.set(event.fileId, clone(choice.file)); indexes.set(event.fileId, clone(choice.index));
      run.registeredFrameCount = String(BigInt(run.registeredFrameCount) + 1n);
      s.lastFile = event.fileId; s.screenHash = choice.screenHash; s.durableElapsed = choice.index.lastElapsedMs; s.durableCapturedAt = choice.capturedAt;
      cover(s, choice.index.lastElapsedMs, choice.capturedAt);
    } else if (event.type === "checkpoint") {
      const index = indexes.get(event.fileId) ?? corrupt(), s = segmentFor(index.segmentId);
      seq(event.elapsedMs, true); timestamp(event.capturedAt);
      if (s.lastFile !== event.fileId || s.segment.endedAt !== null || BigInt(event.elapsedMs) < BigInt(index.lastElapsedMs)) corrupt();
      index.lastElapsedMs = event.elapsedMs; s.durableElapsed = event.elapsedMs; s.durableCapturedAt = event.capturedAt;
      cover(s, event.elapsedMs, event.capturedAt);
    } else if (event.type === "gap") {
      const s = segmentFor(event.gap.segmentId); seq(event.gap.startElapsedMs, true);
      timestamp(event.capturedAt);
      if (s.segment.endedAt !== null || event.gap.endElapsedMs !== null || gaps.some(g => !("kind" in g) && g.segmentId === event.gap.segmentId && g.endElapsedMs === null) || BigInt(event.gap.startElapsedMs) <= BigInt(s.durableElapsed) && s.lastFile !== null) corrupt();
      gaps.push(clone(event.gap)); s.screenHash = null;
      cover(s, event.gap.startElapsedMs, event.capturedAt);
    } else if (event.type === "gap_end") {
      const gap = gaps.findLast(g => !("kind" in g) && g.segmentId === event.segmentId && g.endElapsedMs === null);
      seq(event.endElapsedMs, true); if (!gap || "kind" in gap || BigInt(event.endElapsedMs) < BigInt(gap.startElapsedMs)) corrupt();
      (gap as SessionV2IntervalGap).endElapsedMs = event.endElapsedMs;
      cover(segmentFor(event.segmentId), event.endElapsedMs);
    } else if (event.type === "gap_limit") {
      const gap = gaps.findLast(g => !("kind" in g) && g.segmentId === event.segmentId && g.endElapsedMs === null);
      if (!gap || "kind" in gap || gap.reason !== "read_interrupted") corrupt();
      (gap as SessionV2IntervalGap).reason = "recording_limit";
    } else if (event.type === "segment_end") {
      const s = segmentFor(event.segmentId); timestamp(event.boundary.endedAt); seq(event.boundary.durationMs, true);
      if (s.segment.endedAt !== null || BigInt(event.boundary.durationMs) < BigInt(s.coverageBoundary?.durationMs ?? "0") || Date.parse(event.boundary.endedAt) < Date.parse(s.segment.startedAt)) corrupt();
      s.segment.endedAt = event.boundary.endedAt; s.segment.durationMs = event.boundary.durationMs;
    } else if (event.type === "error") {
      const run = runs.get(event.executionGeneration) ?? corrupt();
      if (event.code !== "source_corrupt" && event.code !== "recording_limit") corrupt();
      if (run.captureError !== "source_corrupt") run.captureError = event.code;
      if (event.code === "source_corrupt") failed = true;
    } else if (event.type === "run_end") {
      const run = runs.get(event.executionGeneration) ?? corrupt();
      if (run.closed || [...segments.values()].some(s => s.segment.executionGeneration === event.executionGeneration && s.segment.endedAt === null)) corrupt();
      run.closed = true;
    } else corrupt();
  };
  const append = (event: Event): void => {
    const body = { revision: String(revision + 1n), previous: chain, event }, line = { ...body, sha256: digest(canonicalSessionJson(body)) };
    const fd = openSync(journal, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const current = fstatSync(fd);
      if (!current.isFile() || current.dev !== journalIdentity.dev || current.ino !== journalIdentity.ino || current.size !== journalLength) corrupt();
      const data = `${canonicalSessionJson(line)}\n`; writeFileSync(fd, data); fsyncSync(fd); journalLength += Buffer.byteLength(data);
    } catch (error) { failed = true; throw error; } finally { closeSync(fd); }
    apply(event); revision++; chain = line.sha256;
  };
  const markFailed = (generation?: string): void => {
    failed = true;
    for (const run of runs.values()) if (generation === undefined || run.executionGeneration === generation) {
      if (run.captureError === "source_corrupt") continue;
      try { append({ type: "error", executionGeneration: run.executionGeneration, code: "source_corrupt" }); }
      catch { run.captureError = "source_corrupt"; }
    }
  };
  const rawJournal = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(journal));
  if (rawJournal !== "" && !rawJournal.endsWith("\n")) corrupt();
  for (const raw of rawJournal.split("\n")) {
    if (!raw) continue;
    const line = decodeStrictSessionJson(raw, 1024 * 1024) as JournalLine;
    if (!line || typeof line !== "object" || Object.keys(line).sort().join() !== "event,previous,revision,sha256" || line.revision !== String(revision + 1n) || line.previous !== chain || line.sha256 !== digest(canonicalSessionJson({ revision: line.revision, previous: line.previous, event: line.event }))) corrupt();
    apply(line.event); revision++; chain = line.sha256;
  }
  const readFrame = (file: FileRecord, synchronize = false): string => {
    const filename = path.join(framesDirectory, `${uuid(file.fileId)}.json`);
    const parent = lstatSync(framesDirectory, { bigint: true }), expected = lstatSync(filename, { bigint: true });
    if (!parent.isDirectory() || parent.isSymbolicLink() || !expected.isFile() || expected.isSymbolicLink()) corrupt();
    const fd = openSync(filename, (synchronize ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino || String(before.size) !== file.byteLength || before.size > BigInt(SESSION_V2_LIMITS.frameMaxBytes)) corrupt();
      const raw = readFileSync(fd);
      if (String(raw.byteLength) !== file.byteLength || digest(raw) !== file.sha256) corrupt();
      const frame = parseTerminalFrame(decodeStrictSessionJson(raw, SESSION_V2_LIMITS.frameMaxBytes));
      if (frame.frameSeq !== file.frameSeq || frame.elapsedMs !== (selected.get(file.fileId) ?? corrupt()).index.firstElapsedMs || frame.capturedAt !== selected.get(file.fileId)!.capturedAt) corrupt();
      if (synchronize) {
        // A selected file may be visible after a crash before either durability
        // barrier completed. Registration requires both the bytes and its name.
        fsyncSync(fd); syncHerdrDirectory(framesDirectory);
      }
      const after = lstatSync(filename, { bigint: true }), currentParent = lstatSync(framesDirectory, { bigint: true });
      if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || !currentParent.isDirectory() || currentParent.isSymbolicLink() || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino) corrupt();
      return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } finally { closeSync(fd); }
  };
  try {
    if (failed) corrupt();
    for (const selection of selected.values()) {
      const data = readFrame(selection.file, !files.has(selection.file.fileId));
      const { width, height, rows } = parseTerminalFrame(JSON.parse(data));
      if (digest(canonicalSessionJson({ width, height, rows })) !== selection.screenHash) corrupt();
      if (!files.has(selection.file.fileId)) append({ type: "register", fileId: selection.file.fileId });
    }
    // Unknown files cannot be adopted without the durable selection that owns them.
    for (const name of readdirSync(framesDirectory)) if (name.endsWith(".json") && !selected.has(name.slice(0, -5))) corrupt();
    recordingBytes = bytes({ files: [...files.values()].map(file => ({ ...file, data: readFrame(file) })), index: [...indexes.values()] });
    if (recordingBytes > SESSION_V2_LIMITS.recordingMaxBytes || files.size > SESSION_V2_LIMITS.maxFrames || segments.size > SESSION_V2_LIMITS.maxSegments || gaps.length > SESSION_V2_LIMITS.maxGaps) corrupt();
  } catch (error) { markFailed(); throw error; }
  const status = () => ({ ...clone(identity), runs: clone([...runs.values()]), failed, recordingBytes, directory });
  const verifyJournal = (): Buffer => {
    safeFile(journal); safeFile(manifest);
    if (!same(decodeStrictSessionJson(readFileSync(manifest), 16_384), header)) corrupt();
    const raw = readFileSync(journal), text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (raw.byteLength !== journalLength || text !== "" && !text.endsWith("\n")) corrupt();
    let observedRevision = 0n, observedChain = digest(canonicalSessionJson(header));
    for (const value of text.split("\n")) {
      if (!value) continue;
      const line = decodeStrictSessionJson(value, 1024 * 1024) as JournalLine;
      if (!line || typeof line !== "object" || Object.keys(line).sort().join() !== "event,previous,revision,sha256" || line.revision !== String(observedRevision + 1n) || line.previous !== observedChain || line.sha256 !== digest(canonicalSessionJson({ revision: line.revision, previous: line.previous, event: line.event }))) corrupt();
      observedRevision++; observedChain = line.sha256;
    }
    if (observedRevision !== revision || observedChain !== chain) corrupt();
    return raw;
  };
  const openGap = (segmentId: string): SessionV2IntervalGap | undefined => gaps.findLast(g => !("kind" in g) && g.segmentId === segmentId && g.endElapsedMs === null) as SessionV2IntervalGap | undefined;
  const limit = (segmentId: string, elapsedMs: string, capturedAt?: string): void => {
    const s = segmentFor(segmentId), run = runFor(segmentId);
    if (run.captureError === "recording_limit") return;
    const start = BigInt(elapsedMs) > BigInt(s.durableElapsed) ? elapsedMs : String(BigInt(s.durableElapsed) + 1n);
    const existing = openGap(segmentId);
    if (existing && BigInt(start) <= BigInt(existing.startElapsedMs)) append({ type: "gap_limit", segmentId });
    else {
      if (gaps.length >= SESSION_V2_LIMITS.maxGaps) { markFailed(run.executionGeneration); corrupt(); }
      if (existing) append({ type: "gap_end", segmentId, endElapsedMs: String(BigInt(start) - 1n) });
      append({ type: "gap", gap: { segmentId, reason: "recording_limit", startElapsedMs: start, endElapsedMs: null }, capturedAt: capturedAt ?? new Date(Date.parse(s.durableCapturedAt) + Number(BigInt(start) - BigInt(s.durableElapsed))).toISOString() });
    }
    append({ type: "error", executionGeneration: run.executionGeneration, code: "recording_limit" }); pending.delete(segmentId);
  };
  const checkpoint = (segmentId: string): void => {
    const s = segmentFor(segmentId), observation = pending.get(segmentId);
    if (failed || !observation || s.lastFile === null || runFor(segmentId).captureError !== null) return;
    const index = indexes.get(s.lastFile)!;
    if (BigInt(observation.elapsedMs) <= BigInt(index.lastElapsedMs)) { pending.delete(segmentId); return; }
    const next = { ...index, lastElapsedMs: observation.elapsedMs }, delta = bytes(next) - bytes(index);
    if (recordingBytes + delta > SESSION_V2_LIMITS.recordingMaxBytes) { limit(segmentId, observation.elapsedMs, observation.capturedAt); return; }
    try { append({ type: "checkpoint", fileId: s.lastFile, ...observation }); recordingBytes += delta; pending.delete(segmentId); }
    catch (error) { markFailed(runFor(segmentId).executionGeneration); throw error; }
  };
  const recoveryBoundary = (segmentId: string): HerdrRecordingBoundary => {
    const s = segmentFor(segmentId);
    if (s.segment.endedAt !== null && s.segment.durationMs !== null) return { endedAt: s.segment.endedAt, durationMs: s.segment.durationMs };
    return s.coverageBoundary ? clone(s.coverageBoundary) : { endedAt: s.segment.startedAt, durationMs: "0" };
  };
  return {
    directory,
    status,
    metadata: () => ({ gaps: clone(gaps) }),
    registerRun: (executionGeneration: string, recordingEnabled = true): HerdrRecordingRun => {
      seq(executionGeneration); if (failed) corrupt();
      const previous = runs.get(executionGeneration);
      if (previous) { if (previous.recordingEnabled !== recordingEnabled) corrupt(); return clone(previous); }
      if (runs.size >= SESSION_V2_LIMITS.maxRuns) throw new SessionV2Error("recording_limit");
      const run: HerdrRecordingRun = { executionGeneration, responsibilityId: randomUUID(), recordingEnabled, selectedFrameCount: "0", registeredFrameCount: "0", captureError: null, closed: false };
      append({ type: "run", run }); return clone(run);
    },
    canOpenSegment: (recovering = false): boolean => {
      const missingTail = recovering && [...segments.values()].some(s => s.segment.endedAt === null && !openGap(s.segment.segmentId)) ? 1 : 0;
      return !failed && files.size < SESSION_V2_LIMITS.maxFrames && recordingBytes < SESSION_V2_LIMITS.recordingMaxBytes && segments.size < SESSION_V2_LIMITS.maxSegments && gaps.length + missingTail < SESSION_V2_LIMITS.maxGaps - 1;
    },
    openSegment: (segment: HerdrLocalSegment): void => {
      if (failed) corrupt();
      const previous = segments.get(segment.segmentId);
      if (previous) { assertTerminalBinding(previous.segment.binding, segment.binding); if (previous.segment.startedAt !== segment.startedAt || previous.segment.executionGeneration !== segment.executionGeneration || previous.segment.segmentOrdinal !== segment.segmentOrdinal) corrupt(); return; }
      if (segments.size >= SESSION_V2_LIMITS.maxSegments || gaps.length >= SESSION_V2_LIMITS.maxGaps - 1) throw new SessionV2Error("recording_limit");
      append({ type: "segment", segment });
    },
    enrichBinding: (executionGeneration: string, binding: TerminalBinding): void => {
      const matching = [...segments.values()].filter(s => s.segment.executionGeneration === executionGeneration);
      for (const s of matching) assertTerminalBinding(s.segment.binding, binding);
      if (matching.some(s => !same(s.segment.binding, binding))) append({ type: "binding", executionGeneration, binding });
    },
    sample: (segmentId: string, screen: HerdrRecordingScreen, observation: HerdrRecordingObservation): { frame: TerminalFrame; recorded: boolean; changed: boolean } => {
      const s = segmentFor(segmentId), run = runFor(segmentId);
      if (s.segment.endedAt !== null || run.closed) throw new Error("A closed recording cannot accept another observation.");
      seq(observation.elapsedMs, true); timestamp(observation.capturedAt);
      if (BigInt(observation.elapsedMs) < BigInt(s.durableElapsed) || Date.parse(observation.capturedAt) < Date.parse(s.segment.startedAt)) corrupt();
      const screenHash = digest(canonicalSessionJson(screen));
      const previous = s.lastFile === null ? null : indexes.get(s.lastFile)!;
      const sameScreen = s.screenHash === screenHash && previous !== null && openGap(segmentId) === undefined;
      if (sameScreen && !failed && run.captureError === null && run.recordingEnabled) {
        pending.set(segmentId, clone(observation));
        if (BigInt(observation.elapsedMs) - BigInt(s.durableElapsed) >= BigInt(SESSION_V2_LIMITS.checkpointIntervalMs)) checkpoint(segmentId);
        return { frame: parseTerminalFrame(JSON.parse(readFrame(files.get(s.lastFile!)!))), recorded: run.captureError === null, changed: false };
      }
      const nextSeq = (liveSequences.get(segmentId) ?? BigInt(previous?.frameSeq ?? "0")) + 1n; liveSequences.set(segmentId, nextSeq);
      let frame: TerminalFrame;
      try { frame = parseTerminalFrame({ ...screen, ...observation, frameSeq: String(nextSeq), full: true }); }
      catch (error) { if (!failed && run.captureError === null) limit(segmentId, observation.elapsedMs, observation.capturedAt); throw error; }
      if (failed || run.captureError !== null || !run.recordingEnabled) return { frame, recorded: false, changed: true };
      checkpoint(segmentId);
      if (run.captureError !== null) return { frame, recorded: false, changed: true };
      const gap = openGap(segmentId);
      if (gap) {
        if (BigInt(observation.elapsedMs) <= BigInt(gap.startElapsedMs)) return { frame, recorded: false, changed: true };
        append({ type: "gap_end", segmentId, endElapsedMs: String(BigInt(observation.elapsedMs) - 1n) });
      }
      if (previous && BigInt(observation.elapsedMs) <= BigInt(previous.lastElapsedMs)) throw new Error("Distinct frames require increasing monotonic observation times.");
      const data = canonicalSessionJson(frame), file: FileRecord = { fileId: randomUUID(), segmentId, frameSeq: frame.frameSeq, sha256: digest(data), byteLength: String(Buffer.byteLength(data)) };
      const index: SessionV2FrameIndex = { segmentId, frameSeq: frame.frameSeq, fileId: file.fileId, firstElapsedMs: observation.elapsedMs, lastElapsedMs: observation.elapsedMs };
      const delta = bytes({ ...file, data }) + bytes(index) + (files.size === 0 ? 0 : 2);
      // Reserve growth of the final checkpoint's signed-int64 decimal counter.
      if (files.size >= SESSION_V2_LIMITS.maxFrames || recordingBytes + delta + 19 - observation.elapsedMs.length > SESSION_V2_LIMITS.recordingMaxBytes) {
        limit(segmentId, observation.elapsedMs, observation.capturedAt); return { frame, recorded: false, changed: true };
      }
      try {
        append({ type: "select", selected: { file, index, screenHash, capturedAt: observation.capturedAt } });
        durableFile(path.join(framesDirectory, `${file.fileId}.json`), data);
        append({ type: "register", fileId: file.fileId }); recordingBytes += delta;
        return { frame, recorded: true, changed: true };
      } catch (error) { markFailed(run.executionGeneration); throw error; }
    },
    checkpoint,
    limit,
    interrupt: (segmentId: string, elapsedMs: string, capturedAt?: string): void => {
      const run = runFor(segmentId), s = segmentFor(segmentId); seq(elapsedMs, true);
      if (failed || run.captureError !== null || openGap(segmentId)) return;
      checkpoint(segmentId);
      if (gaps.length >= SESSION_V2_LIMITS.maxGaps - 1) { limit(segmentId, elapsedMs, capturedAt); return; }
      const start = BigInt(elapsedMs) > BigInt(s.durableElapsed) ? elapsedMs : String(BigInt(s.durableElapsed) + 1n);
      append({ type: "gap", gap: { segmentId, reason: "read_interrupted", startElapsedMs: start, endElapsedMs: null }, capturedAt: capturedAt ?? new Date(Date.parse(s.durableCapturedAt) + Number(BigInt(start) - BigInt(s.durableElapsed))).toISOString() });
    },
    fail: (executionGeneration?: string): void => markFailed(executionGeneration),
    recoveryBoundary,
    closedBoundary: (segmentId: string): HerdrRecordingBoundary | null => {
      const s = segmentFor(segmentId);
      if (failed) corrupt();
      return s.segment.endedAt === null ? null : recoveryBoundary(segmentId);
    },
    recoverSegment: (segmentId: string): HerdrRecordingBoundary => {
      const s = segmentFor(segmentId);
      if (failed) corrupt();
      if (s.segment.endedAt !== null) return recoveryBoundary(segmentId);
      pending.delete(segmentId);
      if (!openGap(segmentId)) {
        if (gaps.length >= SESSION_V2_LIMITS.maxGaps || s.coverageBoundary?.durationMs === "9223372036854775807") { markFailed(s.segment.executionGeneration); corrupt(); }
        // The marker follows every committed frame or closed gap, including a
        // gap_end committed before the next selected frame or limit marker.
        const startElapsedMs = s.coverageBoundary === null ? "0" : String(BigInt(s.coverageBoundary.durationMs) + 1n);
        append({ type: "gap", gap: { segmentId, reason: "checkpoint_lost", startElapsedMs, endElapsedMs: null }, capturedAt: s.coverageBoundary?.endedAt ?? s.segment.startedAt });
      }
      const boundary = recoveryBoundary(segmentId);
      append({ type: "segment_end", segmentId, boundary });
      return boundary;
    },
    endSegment: (segmentId: string, boundary: HerdrRecordingBoundary): void => {
      const s = segmentFor(segmentId); if (s.segment.endedAt !== null) { if (s.segment.endedAt !== boundary.endedAt || s.segment.durationMs !== boundary.durationMs) corrupt(); return; }
      checkpoint(segmentId);
      if (BigInt(boundary.durationMs) < BigInt(s.coverageBoundary?.durationMs ?? "0")) { markFailed(s.segment.executionGeneration); corrupt(); }
      append({ type: "segment_end", segmentId, boundary });
    },
    closeRun: (executionGeneration: string): void => {
      const run = runs.get(executionGeneration) ?? corrupt(); if (run.closed) return;
      if (run.registeredFrameCount === "0" && gaps.some(g => !("kind" in g) && segments.get(g.segmentId)?.segment.executionGeneration === executionGeneration)) markFailed(executionGeneration);
      append({ type: "run_end", executionGeneration });
    },
    snapshot: (): HerdrRecordingSnapshot => {
      if (failed) corrupt();
      try {
        const journalBytes = verifyJournal();
        const outputFiles = [...files.values()].map(file => ({ ...clone(file), data: readFrame(file) }));
        const outputIndex = clone([...indexes.values()]);
        if (selected.size !== files.size || bytes({ files: outputFiles, index: outputIndex }) !== recordingBytes) corrupt();
        const outputSegments: SessionV2Segment[] = [...segments.values()].map(s => ({ segmentId: s.segment.segmentId, segmentOrdinal: s.segment.segmentOrdinal, executionGeneration: s.segment.executionGeneration, binding: clone(s.segment.binding), startedAt: s.segment.startedAt, ...recoveryBoundary(s.segment.segmentId) }));
        const intervals = gaps.filter(g => !("kind" in g)).sort((a, b) => Number(BigInt(segmentFor((a as SessionV2IntervalGap).segmentId).segment.segmentOrdinal) - BigInt(segmentFor((b as SessionV2IntervalGap).segmentId).segment.segmentOrdinal)) || Number(BigInt((a as SessionV2IntervalGap).startElapsedMs) - BigInt((b as SessionV2IntervalGap).startElapsedMs)));
        return { schemaVersion: 1, ...clone(identity), runs: clone([...runs.values()]), segments: outputSegments, files: outputFiles, index: outputIndex, gaps: clone([...intervals, ...gaps.filter(g => "kind" in g)]), journalSha256: digest(journalBytes) };
      } catch (error) { markFailed(); throw error; }
    },
  };
};
export type HerdrRecordingStore = ReturnType<typeof openHerdrRecordingStore>;
