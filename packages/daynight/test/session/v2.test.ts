import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSessionV2Message } from "../../src/session/v2/protocol.js";
import { parseTerminalFrame, assertNativeSessionIdProgression } from "../../src/session/v2/recording.js";
import { decodeSessionV2Archive, parseSessionV2Archive } from "../../src/session/v2/archive.js";
import { sourceDigest, emptySourceDigest } from "../../src/session/v2/responsibility.js";
import { SESSION_PROTOCOL_HEADER, SESSION_V2_LIMITS, canonicalSessionJson, decodeStrictSessionJson, hashSessionBytes } from "../../src/session/v2/values.js";

const root = new URL("./fixtures/v2/", import.meta.url);
const fixture = (name: string): any => JSON.parse(readFileSync(new URL(name + ".json", root), "utf8"));

describe("Session v2 strict wire values", () => {
  it("rejects duplicate decoded object keys before JSON loses them", () => {
    expect(() => decodeStrictSessionJson('{"a":1,"\\u0061":2}')).toThrow();
  });

});

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

});

describe("historical archive status", () => {
  it.each(["valid-status", "valid-status-pending", "valid-status-failed", "valid-status-unavailable"])("accepts %s", name => {
    expect(parseSessionV2Message(fixture(name)).type).toBe("archive_status");
  });
  it("rejects live messages and inconsistent archive status", () => {
    const status = fixture("valid-status");
    expect(() => parseSessionV2Message({ ...status, type: "snapshot" })).toThrow();
    expect(() => parseSessionV2Message({ ...status, payload: { ...status.payload, sha256: null } })).toThrow();
    expect(() => parseSessionV2Message({ ...status, agentControlMode: "web" })).toThrow();
  });
});

describe("Session v2 limits and integrity", () => {
  it("preserves every agreed resource and time boundary", () => {
    expect({ protocolHeader: SESSION_PROTOCOL_HEADER, ...SESSION_V2_LIMITS }).toEqual(JSON.parse(readFileSync(new URL("limits.json", root), "utf8")));
  });
  it("accepts native identity only as unknown then a stable value", () => {
    expect(() => assertNativeSessionIdProgression(null, "session:opaque")).not.toThrow();
    expect(() => assertNativeSessionIdProgression("session:opaque", "session:opaque")).not.toThrow();
    expect(() => assertNativeSessionIdProgression("session:opaque", null)).toThrow();
    expect(() => assertNativeSessionIdProgression("session:opaque", "replacement")).toThrow();
  });
  it("accepts dimension maxima and rejects fractional or overflowing sizes", () => {
    const frame = JSON.parse(fixture("valid-archive").files[0].data); frame.width = 1000; frame.height = 1000; frame.rows = Array.from({ length: 1000 }, () => []);
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
