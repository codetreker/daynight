import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeSessionV2Message, parseSessionV2Message, parseTerminalFrame, assertNativeSessionIdProgression } from "../../src/session/v2/protocol.js";
import { decodeSessionV2Archive, parseSessionV2Archive } from "../../src/session/v2/archive.js";
import { SESSION_PROTOCOL_HEADER, SESSION_V2_LIMITS, canonicalSessionJson, decodeStrictSessionJson, hashSessionBytes, selectSessionProtocol } from "../../src/session/v2/values.js";

const root = new URL("./fixtures/v2/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as { cases: { file: string; type: "message" | "archive"; valid: boolean }[] };
const fixture = (name: string): any => JSON.parse(readFileSync(new URL(name + ".json", root), "utf8"));

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
