import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeSessionV2Message } from "../../src/session/v2/protocol.js";
import { decodeSessionV2Archive, parseSessionV2Archive } from "../../src/session/v2/archive.js";
import { SESSION_V2_LIMITS, canonicalSessionJson } from "../../src/session/v2/values.js";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");

const root = new URL("./fixtures/v2/", import.meta.url);
const fixture = (name: string): any => JSON.parse(readFileSync(new URL(name + ".json", root), "utf8"));

describe("Session v2 declared collection boundaries", () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  it("accepts exactly 1000 ordered segments and gaps", () => {
    const archive = fixture("valid-archive"), first = archive.segments[0];
    archive.segments = Array.from({ length: 1000 }, (_, i) => ({ ...first, segmentId: i === 0 ? first.segmentId : id(100 + i), segmentOrdinal: String(i + 1) }));
    archive.runs[0].segmentIds = archive.segments.map((v: { segmentId: string }) => v.segmentId);
    archive.completeness = "partial";
    archive.gaps = [{ segmentId: first.segmentId, reason: "read_interrupted", startElapsedMs: "5001", endElapsedMs: "5002" }, ...archive.segments.slice(1).map((v: { segmentId: string }, i: number) => ({ kind: "boundary", reason: "restart", from: { executionGeneration: "1", segmentId: archive.segments[i].segmentId }, to: { executionGeneration: "1", segmentId: v.segmentId } }))];
    expect(parseSessionV2Archive(archive).segments).toHaveLength(1000);
    expect(parseSessionV2Archive(archive).gaps).toHaveLength(1000);
  });
  it("accepts exactly 100000 frame references within the package budget", () => {
    const archive = fixture("valid-archive"), first = archive.files[0], segmentId = first.segmentId;
    archive.segments[0].durationMs = "100000";
    archive.files = Array.from({ length: 100000 }, (_, i) => {
      const frame = { frameSeq: String(i + 1), capturedAt: archive.startedAt, elapsedMs: String(i), width: 1, height: 1, full: true, rows: [[]] }, data = JSON.stringify(frame);
      return { fileId: id(100 + i), segmentId, frameSeq: String(i + 1), sha256: "0".repeat(64), byteLength: String(data.length), data };
    });
    archive.index = archive.files.map((file: { fileId: string; frameSeq: string }, i: number) => ({ segmentId, frameSeq: file.frameSeq, fileId: file.fileId, firstElapsedMs: String(i), lastElapsedMs: String(i) }));
    // Structural parsing is intentional: integrity is exercised by raw fixtures.
    expect(parseSessionV2Archive(archive).index).toHaveLength(100000);
  }, 30000);
});

it("accepts the exact 60 MiB recording budget and rejects one additional byte", () => {
  const archive = fixture("valid-archive"), segmentId = archive.files[0].segmentId;
  archive.files = Array.from({ length: 240 }, (_, i) => {
    let data = JSON.stringify({ frameSeq: String(i + 1), capturedAt: archive.startedAt, elapsedMs: String(i), width: 1, height: 1, full: true, rows: [[]] });
    data += " ".repeat(SESSION_V2_LIMITS.frameMaxBytes - data.length);
    return { fileId: `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`, segmentId, frameSeq: String(i + 1), sha256: "0".repeat(64), byteLength: String(data.length), data };
  });
  archive.index = archive.files.map((file: { fileId: string; frameSeq: string }, i: number) => ({ segmentId, frameSeq: file.frameSeq, fileId: file.fileId, firstElapsedMs: String(i), lastElapsedMs: String(i) }));
  const last = archive.files.at(-1), size = () => new TextEncoder().encode(canonicalSessionJson({ files: archive.files, index: archive.index })).length;
  for (let i = 0; i < 3; i++) { const excess = size() - SESSION_V2_LIMITS.recordingMaxBytes; last.data = excess > 0 ? last.data.slice(0, -excess) : last.data + " ".repeat(-excess); last.byteLength = String(last.data.length); }
  expect(size()).toBe(SESSION_V2_LIMITS.recordingMaxBytes);
  expect(parseSessionV2Archive(archive).files).toHaveLength(240);
  last.data += " "; last.byteLength = String(last.data.length);
  expect(() => parseSessionV2Archive(archive)).toThrow();
}, 30000);

it("applies the 4 MiB message and 64 MiB archive raw limits before parsing", async () => {
  const message = JSON.stringify(fixture("valid-registration"));
  const boundedMessage = " ".repeat(SESSION_V2_LIMITS.metadataMaxBytes - new TextEncoder().encode(message).length) + message;
  await expect(decodeSessionV2Message(boundedMessage)).resolves.toBeDefined();
  await expect(decodeSessionV2Message(" " + boundedMessage)).rejects.toThrow();
  const body = JSON.stringify(fixture("valid-archive"));
  const boundedArchive = " ".repeat(SESSION_V2_LIMITS.archiveMaxBytes - new TextEncoder().encode(body).length) + body;
  await expect(decodeSessionV2Archive(boundedArchive)).resolves.toBeDefined();
  await expect(decodeSessionV2Archive(" " + boundedArchive)).rejects.toThrow();
}, 30000);

it("reserves exactly 4 MiB for metadata without consuming the frame budget", () => {
  const archive = fixture("valid-archive"), original = archive.runs[0], bootId = "b".repeat(256);
  archive.executionGeneration = "8";
  archive.runs = Array.from({ length: 8 }, (_, runIndex) => {
    const run = structuredClone(original); run.executionGeneration = String(runIndex + 1); run.segmentIds = runIndex === 0 ? original.segmentIds : [];
    run.stopProof.executionGeneration = run.executionGeneration; run.stopProof.recordId = `00000000-0000-4000-8000-${String(runIndex + 800).padStart(12, "0")}`; run.stopProof.bootId = bootId;
    run.stopProof.processes = Array.from({ length: 1000 }, (_, i) => ({ role: i === 0 ? "shell" : "agent", pid: i + 100, birthToken: `token:${runIndex}:${i}:`.padEnd(256, "x"), bootId }));
    return run;
  });
  archive.completeness = "partial";
  archive.gaps = archive.runs.slice(1).map((run: { executionGeneration: string }, i: number) => ({ kind: "boundary", reason: "restart", from: { executionGeneration: String(i + 1), segmentId: i === 0 ? original.segmentIds[0] : null }, to: { executionGeneration: run.executionGeneration, segmentId: null } }));
  archive.unavailableRuns = archive.runs.slice(1).map((run: { executionGeneration: string }) => ({ executionGeneration: run.executionGeneration, reason: "ended_before_first_sample", evidence: { recordingEnabled: true, selectedFrameCount: "0", registeredFrameCount: "0", captureError: null } }));
  const recordingBytes = new TextEncoder().encode(canonicalSessionJson({ files: archive.files, index: archive.index })).length;
  const metadataBytes = () => new TextEncoder().encode(canonicalSessionJson(archive)).length - recordingBytes;
  let excess = metadataBytes() - SESSION_V2_LIMITS.metadataMaxBytes;
  expect(excess).toBeGreaterThan(0);
  for (const run of archive.runs) for (const process of run.stopProof.processes) {
    const remove = Math.min(excess, process.birthToken.length - 24);
    process.birthToken = process.birthToken.slice(0, process.birthToken.length - remove); excess -= remove;
  }
  expect(excess).toBe(0); expect(metadataBytes()).toBe(SESSION_V2_LIMITS.metadataMaxBytes);
  expect(recordingBytes).toBeLessThan(1024);
  expect(parseSessionV2Archive(archive).runs).toHaveLength(8);
  archive.runs[0].stopProof.processes[0].birthToken += "x";
  expect(metadataBytes()).toBe(SESSION_V2_LIMITS.metadataMaxBytes + 1);
  expect(() => parseSessionV2Archive(archive)).toThrow();
}, 30000);
