import { describe, expect, it } from "vitest";
import { decodeStrictSessionJson, selectSessionProtocol } from "../../src/session/v2/values.js";

describe("Session v2 strict wire values", () => {
  it("rejects duplicate decoded object keys before JSON loses them", () => {
    expect(() => decodeStrictSessionJson('{"a":1,"\\u0061":2}')).toThrow();
  });
  it("defaults absent selection to v1 and rejects unknown protocols", () => {
    expect(selectSessionProtocol(null)).toBe("daynight.session.v1");
    expect(selectSessionProtocol("daynight.session.v2")).toBe("daynight.session.v2");
    expect(() => selectSessionProtocol("daynight.session.v3")).toThrow();
  });
});

import { readFileSync } from "node:fs";
import { decodeSessionV2Message, parseSessionV2Message, parseTerminalFrame, assertNativeSessionIdProgression } from "../../src/session/v2/protocol.js";
import { decodeSessionV2Archive, parseSessionV2Archive } from "../../src/session/v2/archive.js";
import { sourceDigest, emptySourceDigest } from "../../src/session/v2/responsibility.js";
import { controlRequestDigest } from "../../src/session/v2/protocol.js";
import { SESSION_PROTOCOL_HEADER, SESSION_V2_LIMITS, canonicalSessionJson, hashSessionBytes } from "../../src/session/v2/values.js";
const root = new URL("./fixtures/v2/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as { cases: { file: string; type: "message" | "archive"; valid: boolean }[] };
const fixture = (name: string): any => JSON.parse(readFileSync(new URL(name + ".json", root), "utf8"));

describe("recording responsibility and authenticated control provenance", () => {
  const vectors = fixture("responsibility-digests") as { emptySourceSha256: string; cases: { file: string; generation: string; sourceSha256: string }[] };
  it("retains exact empty source provenance", async () => {
    expect(await emptySourceDigest()).toBe(vectors.emptySourceSha256);
  });
  it.each(vectors.cases)("binds only the selected run in $file generation $generation", async ({ file, generation, sourceSha256 }) => {
    const archive = await decodeSessionV2Archive(readFileSync(new URL(file, root)));
    expect(await sourceDigest(archive, generation)).toBe(sourceSha256);
    await expect(sourceDigest(archive, "1001")).rejects.toThrow();
  });
  it("binds the control intent to the authenticated actor", async () => {
    const dispatch = fixture("valid-control-dispatch");
    expect(await controlRequestDigest(dispatch.payload.actorUserId, dispatch.payload.request)).toBe(dispatch.payload.requestDigest);
    dispatch.payload.actorUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await expect(decodeSessionV2Message(JSON.stringify(dispatch))).rejects.toThrow();
    const changed = fixture("valid-control-dispatch");
    changed.payload.request.browserClientId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await expect(decodeSessionV2Message(JSON.stringify(changed))).rejects.toThrow();
  });
});

describe("shared Session v2 raw wire corpus", () => {
  it.each(manifest.cases)("$file accepts=$valid", async ({ file, type, valid }) => {
    const bytes = readFileSync(new URL(file, root));
    const result = type === "archive" ? decodeSessionV2Archive(bytes) : decodeSessionV2Message(bytes);
    if (valid) await expect(result).resolves.toBeDefined();
    else await expect(result).rejects.toThrow();
  });
});

describe("Session v2 limits and integrity", () => {
  it("preserves every agreed resource and time boundary", () => {
    expect({ protocolHeader: SESSION_PROTOCOL_HEADER, ...SESSION_V2_LIMITS }).toEqual(JSON.parse(readFileSync(new URL("limits.json", root), "utf8")));
  });
  it("rejects malformed or duplicate raw JSON at any depth", () => {
    for (const raw of ['{"x":{"a":1,"a":1}}', '{"x":[{"a":1,"a":2}]}', '[1,]', '{"a":1,}', 'true false', 'NaN', '1e9999', '"\\udc00"', '"\\ud800x"', '\ufeff{}', '['.repeat(66) + '0' + ']'.repeat(66)]) expect(() => decodeStrictSessionJson(raw)).toThrow();
    expect(decodeStrictSessionJson('{"__proto__":{"x":1},"s":"\\ud83d\\ude00"}')).toEqual({ ["__proto__"]: { x: 1 }, s: "😀" });
  });
  it("checks raw byte size before dropping JSON whitespace", () => {
    expect(decodeStrictSessionJson(' '.repeat(1020) + 'null', 1024)).toBeNull();
    expect(() => decodeStrictSessionJson(' '.repeat(1021) + 'null', 1024)).toThrow();
    expect(() => decodeStrictSessionJson(new Uint8Array([0xef, 0xbb, 0xbf, 123, 125]))).toThrow();
  });
  it("accepts native identity only as unknown then a stable value", () => {
    expect(() => assertNativeSessionIdProgression(null, "session:opaque")).not.toThrow();
    expect(() => assertNativeSessionIdProgression("session:opaque", "session:opaque")).not.toThrow();
    expect(() => assertNativeSessionIdProgression("session:opaque", null)).toThrow();
    expect(() => assertNativeSessionIdProgression("session:opaque", "replacement")).toThrow();
  });
  it("enforces decoded text bytes rather than JS string length", () => {
    const v = fixture("valid-operation"); v.payload.payload.text = "é".repeat(8192);
    expect(() => parseSessionV2Message(v)).not.toThrow(); v.payload.payload.text += "é";
    expect(() => parseSessionV2Message(v)).toThrow();
    const r = fixture("valid-registration"); r.payload.binding.terminalId = "é".repeat(128);
    expect(() => parseSessionV2Message(r)).not.toThrow(); r.payload.binding.terminalId += "x";
    expect(() => parseSessionV2Message(r)).toThrow();
  });
  it("accepts dimension maxima and rejects fractional or overflowing sizes", () => {
    const frame = fixture("valid-snapshot").payload.frame; frame.width = 1000; frame.height = 1000; frame.rows = Array.from({ length: 1000 }, () => []);
    expect(() => parseTerminalFrame(frame)).not.toThrow();
    for (const dimension of [0, -1, 1001, 1.5, Infinity]) expect(() => parseTerminalFrame({ ...frame, width: dimension })).toThrow();
  });
  it("counts exact original frame bytes and checks their hash", async () => {
    const archive = fixture("valid-archive"), file = archive.files[0];
    file.data += ' '.repeat(SESSION_V2_LIMITS.frameMaxBytes - new TextEncoder().encode(file.data).length);
    file.byteLength = String(SESSION_V2_LIMITS.frameMaxBytes); file.sha256 = await hashSessionBytes(file.data);
    await expect(decodeSessionV2Archive(JSON.stringify(archive))).resolves.toBeDefined();
    file.data += ' '; file.byteLength = String(SESSION_V2_LIMITS.frameMaxBytes + 1);
    await expect(decodeSessionV2Archive(JSON.stringify(archive))).rejects.toThrow();
  });
  it("rejects over-count arrays before interpreting missing or duplicate content", () => {
    const archive = fixture("valid-archive");
    for (const [field, size] of [["files", 100001], ["index", 100001], ["segments", 1001], ["gaps", 1001]] as const) {
      expect(() => parseSessionV2Archive({ ...archive, [field]: Array.from({ length: size }, () => archive[field][0] ?? {}) })).toThrow();
    }
  });
  it("uses key order independent canonical bytes and preserves Unicode", async () => {
    const left = canonicalSessionJson({ z: "<\u2028\u2029😀", a: [1, true, null] });
    expect(left).toBe('{"a":[1,true,null],"z":"<\u2028\u2029😀"}');
    expect(await hashSessionBytes(left)).toBe(await hashSessionBytes(canonicalSessionJson({ a: [1, true, null], z: "<\u2028\u2029😀" })));
  });
});


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
