import { fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeHerdrAnsi } from "../../../src/commands/worker/herdr/recording-ansi.js";
import { openHerdrRecordingStore } from "../../../src/commands/worker/herdr/recording-store.js";
import { SESSION_V2_LIMITS, canonicalSessionJson } from "../../../src/session/v2/values.js";
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = { projectId: id(1), taskId: id(2), workerId: id(3), worktreeId: id(4), ownerUserId: id(5), serverOrigin: "https://daynight.example", provider: "codex" as const };
const start = "2026-11-04T00:00:00.000Z";
const binding = { instanceId: "daemon", sessionId: "w", workspaceId: "workspace", paneId: "pane", terminalId: "terminal", nativeSessionId: null };
const segment = { segmentId: id(8), segmentOrdinal: "1", executionGeneration: "1", binding, startedAt: start, endedAt: null, durationMs: null, gap: null };
const root = fileURLToPath(new URL("../../../../../.tmp/herdr-recording-test/", import.meta.url));
const directories: string[] = [];
const fixture = () => {
  mkdirSync(root, { recursive: true }); const directory = mkdtempSync(path.join(root, "run-")); directories.push(directory);
  const options = { directory, owner, sessionId: id(6), claimId: id(7) };
  const store = openHerdrRecordingStore(options); store.registerRun("1"); store.openSegment(segment);
  return { directory, options, store };
};
const screen = (value: string) => ({ width: 80, height: 2, rows: normalizeHerdrAnsi(value, 80, 2) });
const at = (elapsed: number) => ({ elapsedMs: String(elapsed), capturedAt: new Date(Date.parse(start) + elapsed).toISOString() });
afterEach(() => { vi.mocked(fsyncSync).mockReset(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("bounded terminal styled text", () => {
  it("preserves supported SGR and strips OSC clipboard and hyperlinks without executing or retaining controls", () => {
    const rows = normalizeHerdrAnsi("\x1b[31;1m红\x1b[0m!\x1b]52;c;secret\x07\n\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\", 80, 2);
    expect(rows[0]).toEqual([
      { text: "红", foreground: "#800000", background: null, bold: true, italic: false, underline: false, inverse: false },
      { text: "!", foreground: null, background: null, bold: false, italic: false, underline: false, inverse: false },
    ]);
    expect(rows[1]!.map(run => run.text).join("")).toBe("link");
  });
  it("normalizes truecolor and indexed colors and pads empty rows", () => {
    const rows = normalizeHerdrAnsi("\x1b[38;2;1;2;3mA\x1b[48;5;196mB", 20, 3);
    expect(rows[0]![0]!.foreground).toBe("#010203"); expect(rows[0]![1]!.background).toBe("#ff0000");
    expect(rows.slice(1)).toEqual([[], []]);
  });
  it("refuses oversized dimensions or overflowing rows rather than silently truncating the screen", () => {
    expect(() => normalizeHerdrAnsi("a", 1001, 1)).toThrow();
    expect(() => normalizeHerdrAnsi("a\nb", 2, 1)).toThrow();
    expect(() => normalizeHerdrAnsi("x".repeat(16_385), 1000, 1)).toThrow();
  });
});

describe("durable Herdr recording", () => {
  it("writes full frame bytes before exposing a registered frame and deduplicates until the five-second checkpoint", () => {
    const f = fixture();
    expect(f.store.sample(segment.segmentId, screen("first"), at(0))).toMatchObject({ recorded: true, changed: true });
    expect(f.store.sample(segment.segmentId, screen("first"), at(4000))).toMatchObject({ recorded: true, changed: false });
    expect(f.store.snapshot().index[0]!.lastElapsedMs).toBe("0");
    f.store.sample(segment.segmentId, screen("first"), at(5000));
    const snapshot = f.store.snapshot(); expect(snapshot.files).toHaveLength(1); expect(snapshot.index[0]!.lastElapsedMs).toBe("5000");
    expect(snapshot.runs[0]).toMatchObject({ selectedFrameCount: "1", registeredFrameCount: "1", captureError: null });
    expect(readFileSync(path.join(f.directory, "frames", `${snapshot.files[0]!.fileId}.json`), "utf8")).toBe(snapshot.files[0]!.data);
  });
  it("retains only the last durable observation across a crash and uses the caller's registered recovery segment", () => {
    const f = fixture(); f.store.sample(segment.segmentId, screen("first"), at(0)); f.store.sample(segment.segmentId, screen("first"), at(7000));
    f.store.sample(segment.segmentId, screen("first"), at(9000));
    const recovered = openHerdrRecordingStore(f.options);
    expect(recovered.recoveryBoundary(segment.segmentId)).toEqual({ endedAt: at(7000).capturedAt, durationMs: "7000" });
    recovered.endSegment(segment.segmentId, recovered.recoveryBoundary(segment.segmentId));
    const next = { ...segment, segmentId: id(9), segmentOrdinal: "2", startedAt: at(12000).capturedAt,
      gap: { kind: "boundary" as const, reason: "restart" as const, from: { executionGeneration: "1", segmentId: segment.segmentId }, to: { executionGeneration: "1", segmentId: id(9) } } };
    recovered.openSegment(next); recovered.sample(next.segmentId, screen("after"), { elapsedMs: "0", capturedAt: next.startedAt });
    expect(recovered.snapshot().gaps).toEqual([next.gap]);
    expect(recovered.snapshot().index[0]!.lastElapsedMs).toBe("7000");
  });
  it("checkpoints the final same-screen observation on orderly segment closure without extending it to the stop time", () => {
    const f = fixture(); f.store.sample(segment.segmentId, screen("first"), at(0)); f.store.sample(segment.segmentId, screen("first"), at(1000));
    f.store.endSegment(segment.segmentId, { endedAt: at(2000).capturedAt, durationMs: "2000" }); f.store.closeRun("1");
    expect(f.store.snapshot().index[0]!.lastElapsedMs).toBe("1000"); expect(f.store.snapshot().segments[0]!.durationMs).toBe("2000");
    expect(f.store.snapshot().runs[0]!.closed).toBe(true);
  });
  it("recovers an already committed segment end without replacing it by the last frame checkpoint", () => {
    const f = fixture(); f.store.sample(segment.segmentId, screen("first"), at(0));
    const boundary = { endedAt: at(2000).capturedAt, durationMs: "2000" };
    f.store.endSegment(segment.segmentId, boundary);
    const recovered = openHerdrRecordingStore(f.options);
    expect(recovered.recoveryBoundary(segment.segmentId)).toEqual(boundary);
    expect(() => recovered.endSegment(segment.segmentId, recovered.recoveryBoundary(segment.segmentId))).not.toThrow();
  });
  it.each(["missing", "hash"])("fails closed on %s registered content and never silently converts it to a gap", (failure) => {
    const f = fixture(); f.store.sample(segment.segmentId, screen("first"), at(0)); const file = f.store.snapshot().files[0]!;
    const filename = path.join(f.directory, "frames", `${file.fileId}.json`);
    if (failure === "missing") rmSync(filename); else writeFileSync(filename, "{}");
    expect(() => f.store.snapshot()).toThrow(); expect(f.store.status().runs[0]!.captureError).toBe("source_corrupt");
    expect(() => openHerdrRecordingStore(f.options)).toThrow();
  });
  it("hashes physical frame bytes before UTF-8 decoding so replacement characters cannot conceal corrupt bytes", () => {
    const f = fixture(); f.store.sample(segment.segmentId, screen("\ufffd"), at(0)); const file = f.store.snapshot().files[0]!;
    const filename = path.join(f.directory, "frames", `${file.fileId}.json`), original = readFileSync(filename), offset = original.indexOf(Buffer.from("\ufffd"));
    expect(offset).toBeGreaterThan(0); writeFileSync(filename, Buffer.concat([original.subarray(0, offset), Buffer.from([255]), original.subarray(offset + 3)]));
    expect(() => f.store.snapshot()).toThrow();
  });
  it("retains selected-but-unregistered responsibility after a real filesystem write failure", () => {
    const f = fixture(); renameSync(path.join(f.directory, "frames"), path.join(f.directory, "frames-saved")); writeFileSync(path.join(f.directory, "frames"), "blocked");
    expect(() => f.store.sample(segment.segmentId, screen("first"), at(0))).toThrow();
    expect(f.store.status().runs[0]).toMatchObject({ selectedFrameCount: "1", registeredFrameCount: "0", captureError: "source_corrupt" });
  });
  it("refuses another claim's source and a torn journal", () => {
    const f = fixture(); expect(() => openHerdrRecordingStore({ ...f.options, claimId: id(99) })).toThrow();
    const journal = path.join(f.directory, "journal.jsonl"); writeFileSync(journal, `${readFileSync(journal, "utf8")}{"torn":`);
    expect(() => openHerdrRecordingStore(f.options)).toThrow();
  });
  it("detects corruption of the on-disk index even while its original writer remains open", () => {
    const f = fixture(); f.store.sample(segment.segmentId, screen("first"), at(0));
    const journal = path.join(f.directory, "journal.jsonl"), value = readFileSync(journal, "utf8");
    writeFileSync(journal, value.replace('"revision":"1"', '"revision":"9"'));
    expect(() => f.store.snapshot()).toThrow(); expect(f.store.status().failed).toBe(true);
  });
  it.skipIf(process.platform === "win32")("syncs the original orphan file and frames directory before recovering its registration", async () => {
    const f = fixture(); f.store.sample(segment.segmentId, screen("first"), at(0));
    const frame = f.store.snapshot().files[0]!, filename = path.join(f.directory, "frames", `${frame.fileId}.json`);
    const journal = path.join(f.directory, "journal.jsonl"), lines = readFileSync(journal, "utf8").trimEnd().split("\n");
    expect(JSON.parse(lines.at(-1)!).event.type).toBe("register");
    writeFileSync(journal, `${lines.slice(0, -1).join("\n")}\n`);
    const fileInode = lstatSync(filename).ino, directoryInode = lstatSync(path.dirname(filename)).ino, journalInode = lstatSync(journal).ino;
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs"), synced: number[] = [];
    vi.mocked(fsyncSync).mockImplementation(fd => { synced.push(fstatSync(fd).ino); actual.fsyncSync(fd); });
    const restored = openHerdrRecordingStore(f.options).snapshot();
    expect(restored.files).toHaveLength(1); expect(restored.runs[0]).toMatchObject({ selectedFrameCount: "1", registeredFrameCount: "1" });
    expect(synced).toContain(fileInode); expect(synced).toContain(directoryInode);
    expect(synced.indexOf(fileInode)).toBeLessThan(synced.indexOf(directoryInode));
    expect(synced.indexOf(directoryInode)).toBeLessThan(synced.indexOf(journalInode));
  });
  it.each(process.platform === "win32" ? ["file"] : ["file", "directory"])("does not register an orphan when its %s fsync fails", async kind => {
    const f = fixture(); f.store.sample(segment.segmentId, screen("first"), at(0));
    const frame = f.store.snapshot().files[0]!, filename = path.join(f.directory, "frames", `${frame.fileId}.json`);
    const journal = path.join(f.directory, "journal.jsonl"), lines = readFileSync(journal, "utf8").trimEnd().split("\n");
    writeFileSync(journal, `${lines.slice(0, -1).join("\n")}\n`);
    const inode = lstatSync(kind === "file" ? filename : path.dirname(filename)).ino;
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fsyncSync).mockImplementation(fd => {
      if (fstatSync(fd).ino === inode) throw Object.assign(new Error("orphan durability failed"), { code: "EIO" });
      actual.fsyncSync(fd);
    });
    expect(() => openHerdrRecordingStore(f.options)).toThrow("orphan durability failed");
    const events = readFileSync(journal, "utf8").trimEnd().split("\n").map(line => JSON.parse(line).event);
    expect(events.some(event => event.type === "register")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "source_corrupt", executionGeneration: "1" });
    expect(readFileSync(filename, "utf8")).toBe(frame.data);
    vi.mocked(fsyncSync).mockReset();
    expect(() => openHerdrRecordingStore(f.options)).toThrow("source_corrupt");
  });
  it.skipIf(process.platform === "win32")("refuses an identically encoded replacement of the orphan while its original handle is synced", async () => {
    const f = fixture(); f.store.sample(segment.segmentId, screen("first"), at(0));
    const frame = f.store.snapshot().files[0]!, filename = path.join(f.directory, "frames", `${frame.fileId}.json`);
    const journal = path.join(f.directory, "journal.jsonl"), lines = readFileSync(journal, "utf8").trimEnd().split("\n"), inode = lstatSync(filename).ino;
    writeFileSync(journal, `${lines.slice(0, -1).join("\n")}\n`);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fsyncSync).mockImplementation(fd => {
      actual.fsyncSync(fd);
      if (fstatSync(fd).ino === inode) { renameSync(filename, `${filename}.original`); writeFileSync(filename, frame.data); }
    });
    expect(() => openHerdrRecordingStore(f.options)).toThrow("source_corrupt");
    expect(readFileSync(journal, "utf8").trimEnd().split("\n").map(line => JSON.parse(line).event).some(event => event.type === "register")).toBe(false);
  });
  it("will not recover a lost selected file as an innocent zero-frame recording", () => {
    const f = fixture(); f.store.sample(segment.segmentId, screen("first"), at(0)); const file = f.store.snapshot().files[0]!;
    const journal = path.join(f.directory, "journal.jsonl"), lines = readFileSync(journal, "utf8").trimEnd().split("\n");
    writeFileSync(journal, `${lines.slice(0, -1).join("\n")}\n`); rmSync(path.join(f.directory, "frames", `${file.fileId}.json`));
    expect(() => openHerdrRecordingStore(f.options)).toThrow();
  });
  it("closes a normal empty run but preserves a capture-failure empty run as failed", () => {
    const f = fixture(); f.store.endSegment(segment.segmentId, { endedAt: at(10).capturedAt, durationMs: "10" }); f.store.closeRun("1");
    expect(f.store.snapshot().runs[0]).toMatchObject({ recordingEnabled: true, closed: true, captureError: null, selectedFrameCount: "0" });
    const failed = fixture(); failed.store.interrupt(segment.segmentId, "1"); failed.store.endSegment(segment.segmentId, { endedAt: at(10).capturedAt, durationMs: "10" }); failed.store.closeRun("1");
    expect(failed.store.status().runs[0]!.captureError).toBe("source_corrupt"); expect(() => failed.store.snapshot()).toThrow();
  });
  it("preserves a disabled run with no invented segment or frame", () => {
    const f = fixture(); f.store.endSegment(segment.segmentId, { endedAt: at(10).capturedAt, durationMs: "10" }); f.store.closeRun("1");
    f.store.registerRun("2", false); f.store.closeRun("2");
    expect(f.store.snapshot().runs[1]).toMatchObject({ recordingEnabled: false, closed: true, selectedFrameCount: "0", registeredFrameCount: "0" });
    expect(f.store.snapshot().segments).toHaveLength(1);
  });
  it("durably enriches native identity after the first frame and rejects conversation replacement", () => {
    const f = fixture(); f.store.sample(segment.segmentId, screen("initial"), at(0));
    f.store.enrichBinding("1", { ...binding, nativeSessionId: id(90) });
    expect(openHerdrRecordingStore(f.options).snapshot().segments[0]!.binding.nativeSessionId).toBe(id(90));
    expect(() => f.store.enrichBinding("1", { ...binding, nativeSessionId: id(91) })).toThrow();
  });
  it("marks an overlarge frame partial without selecting or deleting it and permits only unsaved live publication", () => {
    const f = fixture(); f.store.sample(segment.segmentId, screen("first"), at(0));
    const rows = Array.from({ length: 20 }, () => [{ text: "x".repeat(16000), foreground: null, background: null, bold: false, italic: false, underline: false, inverse: false }]);
    expect(() => f.store.sample(segment.segmentId, { width: 1000, height: 20, rows }, at(1000))).toThrow();
    expect(f.store.sample(segment.segmentId, screen("later"), at(2000))).toMatchObject({ recorded: false });
    const snapshot = f.store.snapshot(); expect(snapshot.files).toHaveLength(1);
    expect(snapshot.runs[0]).toMatchObject({ captureError: "recording_limit", selectedFrameCount: "1", registeredFrameCount: "1" });
    expect(snapshot.gaps).toEqual([{ segmentId: segment.segmentId, reason: "recording_limit", startElapsedMs: "1000", endElapsedMs: null }]);
  });
  it("records a true read interruption as a gap and does not deduplicate across the unobserved interval", () => {
    const f = fixture(); f.store.sample(segment.segmentId, screen("same"), at(0)); f.store.interrupt(segment.segmentId, "1000");
    f.store.sample(segment.segmentId, screen("same"), at(2000));
    const snapshot = f.store.snapshot(); expect(snapshot.files).toHaveLength(2);
    expect(snapshot.gaps).toEqual([{ segmentId: segment.segmentId, reason: "read_interrupted", startElapsedMs: "1000", endElapsedMs: "1999" }]);
  });
  it("keeps valid source partial when a recording limit follows an unresolved read interruption", () => {
    const f = fixture(); f.store.sample(segment.segmentId, screen("first"), at(0)); f.store.interrupt(segment.segmentId, "1000");
    f.store.limit(segment.segmentId, "2000");
    expect(f.store.snapshot().gaps).toEqual([
      { segmentId: segment.segmentId, reason: "read_interrupted", startElapsedMs: "1000", endElapsedMs: "1999" },
      { segmentId: segment.segmentId, reason: "recording_limit", startElapsedMs: "2000", endElapsedMs: null },
    ]);
    expect(f.store.status().failed).toBe(false);
  });
  it("retains a durable interrupted interval when recovering before the next stable sample", () => {
    const f = fixture(); f.store.sample(segment.segmentId, screen("first"), at(0)); f.store.interrupt(segment.segmentId, "1000");
    const recovered = openHerdrRecordingStore(f.options), boundary = recovered.recoveryBoundary(segment.segmentId);
    recovered.endSegment(segment.segmentId, boundary);
    expect(boundary.durationMs).toBe("1000"); expect(recovered.snapshot().gaps[0]).toMatchObject({ reason: "read_interrupted", startElapsedMs: "1000", endElapsedMs: null });
  });
  it("bounds the exact serialized files-and-index package and preserves already written frames", () => {
    const original = SESSION_V2_LIMITS.recordingMaxBytes;
    try {
    Object.assign(SESSION_V2_LIMITS, { recordingMaxBytes: 1024 * 1024 });
    const f = fixture();
    const rows = Array.from({ length: 16 }, () => [{ text: "x".repeat(16000), foreground: null, background: null, bold: false, italic: false, underline: false, inverse: false }]);
    let accepted = 0;
    for (let i = 0; i < 8; i++) {
      rows[0]![0]!.text = String(i).padStart(6, "0") + "x".repeat(15994);
      const result = f.store.sample(segment.segmentId, { width: 1000, height: 16, rows }, at(i * 350));
      if (!result.recorded) break;
      accepted++;
    }
    expect(accepted).toBeGreaterThan(2); expect(accepted).toBeLessThan(8);
    const snapshot = f.store.snapshot(), actualBytes = Buffer.byteLength(canonicalSessionJson({ files: snapshot.files, index: snapshot.index }));
    expect(actualBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(actualBytes + Buffer.byteLength(canonicalSessionJson(snapshot.files.at(-1)))).toBeGreaterThan(1024 * 1024);
    expect(snapshot.files).toHaveLength(accepted); expect(snapshot.runs[0]!.captureError).toBe("recording_limit");
    } finally { Object.assign(SESSION_V2_LIMITS, { recordingMaxBytes: original }); }
  });
  it("keeps the reserved last gap when the gap-count budget is reached", () => {
    const original = SESSION_V2_LIMITS.maxGaps;
    try {
      Object.assign(SESSION_V2_LIMITS, { maxGaps: 3 });
      const f = fixture(); f.store.sample(segment.segmentId, screen("first"), at(0));
      f.store.interrupt(segment.segmentId, "1000"); f.store.sample(segment.segmentId, screen("second"), at(2000));
      f.store.interrupt(segment.segmentId, "3000"); f.store.sample(segment.segmentId, screen("third"), at(4000));
      f.store.interrupt(segment.segmentId, "5000");
      expect(f.store.sample(segment.segmentId, screen("unsaved"), at(6000))).toMatchObject({ recorded: false });
      const snapshot = f.store.snapshot(); expect(snapshot.gaps).toHaveLength(3); expect(snapshot.gaps.at(-1)).toMatchObject({ reason: "recording_limit", endElapsedMs: null });
      expect(snapshot.runs[0]!.captureError).toBe("recording_limit");
    } finally { Object.assign(SESSION_V2_LIMITS, { maxGaps: original }); }
  });
  it("refuses the next distinct frame at the frame-count budget before selecting content", () => {
    const original = SESSION_V2_LIMITS.maxFrames;
    try {
      Object.assign(SESSION_V2_LIMITS, { maxFrames: 2 });
      const f = fixture(); f.store.sample(segment.segmentId, screen("first"), at(0)); f.store.sample(segment.segmentId, screen("second"), at(1000));
      expect(f.store.sample(segment.segmentId, screen("third"), at(2000))).toMatchObject({ recorded: false });
      expect(f.store.snapshot().runs[0]).toMatchObject({ selectedFrameCount: "2", registeredFrameCount: "2", captureError: "recording_limit" });
    } finally { Object.assign(SESSION_V2_LIMITS, { maxFrames: original }); }
  });
});
