import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import fixture from "./fixtures/history-canonical.json" with { type: "json" };
import { canonicalHistoryJSON, decodeHistoryEntryCursor, decodeHistoryPageCursor, encodeHistoryEntryCursor, encodeHistoryPageCursor, parseEntryChunk, parseInspectionPage, parseSessionMessageItem } from "../../src/session/history.js";

const id = "00000000-0000-4000-8000-000000000001";
const identity = { source: "live" as const, sessionId: id, historyEpoch: id, sourceVersion: id };
it("matches the shared canonical entry bytes for Unicode, fractional numbers and decimal sequences", () => {
  expect(canonicalHistoryJSON(fixture.entry)).toBe(fixture.canonical);
  expect(createHash("sha256").update(canonicalHistoryJSON(fixture.entry)).digest("hex")).toBe(fixture.sha256);
  for (const invalid of [NaN, Infinity, undefined, "\ud800"]) expect(() => canonicalHistoryJSON(invalid)).toThrow();
});

it("keeps page and entry cursors in separate validated source domains", () => {
  const page = { ...identity, entrySeq: "9007199254740993" };
  const chunk = { ...identity, entryId: id, revision: "7", sha256: fixture.sha256, byteLength: "321", offset: "0" };
  expect(decodeHistoryPageCursor(encodeHistoryPageCursor(page))).toEqual(page);
  expect(decodeHistoryEntryCursor(encodeHistoryEntryCursor(chunk))).toEqual(chunk);
  const archived = { ...chunk, source: "archive" as const, historyEpoch: fixture.sha256, sourceVersion: fixture.sha256 };
  expect(decodeHistoryEntryCursor(encodeHistoryEntryCursor(archived))).toEqual(archived);
  for (const malformed of ["", "a".repeat(4097), `${encodeHistoryPageCursor(page)}=`, encodeHistoryEntryCursor(chunk)]) expect(() => decodeHistoryPageCursor(malformed)).toThrow();
  expect(() => decodeHistoryEntryCursor(encodeHistoryEntryCursor({ ...chunk, offset: "322" }))).toThrow();
  expect(() => decodeHistoryPageCursor(encodeHistoryPageCursor({ ...page, sourceVersion: fixture.sha256 }))).toThrow();
});

it("validates empty pages and content chunk progress independently from text rendering", () => {
  expect(parseInspectionPage({ kind: "inspect_page", historyEpoch: id, items: [], beforeCursor: null, hasMoreBefore: false, coverage: { state: "complete", reason: null } }).items).toEqual([]);
  expect(() => parseInspectionPage({ kind: "inspect_page", historyEpoch: id, items: [], beforeCursor: null, hasMoreBefore: true, coverage: { state: "complete", reason: null } })).toThrow();
  const fragment = "\n原文\u001b[0m";
  const chunk = { kind: "entry_chunk", historyEpoch: fixture.sha256, entryId: id, revision: "1", sha256: fixture.sha256, byteLength: String(Buffer.byteLength(fragment)), offset: "0", fragment, nextCursor: null, eof: true };
  expect(parseEntryChunk(chunk).fragment).toBe(fragment);
  expect(() => parseEntryChunk({ ...chunk, offset: "1" })).toThrow();
  expect(() => parseEntryChunk({ ...chunk, byteLength: "999", fragment: "", nextCursor: "cursor", eof: false })).toThrow();
});

it("requires exact and internally consistent inspection coverage", () => {
  const page = { kind: "inspect_page", historyEpoch: id, items: [], beforeCursor: null, hasMoreBefore: false };
  expect(() => parseInspectionPage(page)).toThrow();
  for (const coverage of [{ state: "complete", reason: null }, { state: "partial", reason: "entry_truncated" }, { state: "partial", reason: "resource_unavailable" }]) {
    expect(parseInspectionPage({ ...page, coverage }).coverage).toEqual(coverage);
  }
  for (const coverage of [null, {}, { state: "complete" }, { state: "complete", reason: "entry_truncated" }, { state: "partial", reason: null }, { state: "partial", reason: "unknown" }, { state: "unknown", reason: null }, { state: "complete", reason: null, extra: true }]) {
    expect(() => parseInspectionPage({ ...page, coverage })).toThrow();
  }
});

it("accepts bounded image names in the six-field inspection preview without admitting full resource descriptors", () => {
  const resource = { resourceId: id, status: "available", name: "图".repeat(341) + "x", mediaType: "image/png", byteLength: "10", sha256: "a".repeat(64) };
  const body = { entryId: id, entrySeq: "1", revision: "1", kind: "assistant_message", content: [{ type: "text", text: "image" }] };
  const item = { entryId: id, entrySeq: "1", revision: "1", kind: "assistant_message", role: "assistant", timestamp: null, body, truncated: false, contentRef: null, resources: [resource], resourcesTruncated: false };
  expect(parseSessionMessageItem(item).resources).toEqual([resource]);
  for (const change of [{ name: resource.name + "x" }, { revision: "1", width: 1, height: 1, frameCount: 1 }, { error: null }, { sha256: "invalid" }, { mediaType: "invalid" }, { byteLength: "01" }]) {
    expect(() => parseSessionMessageItem({ ...item, resources: [{ ...resource, ...change }] })).toThrow();
  }
});
