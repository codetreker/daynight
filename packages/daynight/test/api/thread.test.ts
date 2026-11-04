import { describe, expect, it } from "vitest";
import { decodeThreadJsonSource, parseThreadMessage, parseThreadPage, THREAD_MESSAGE_BYTES, THREAD_PAGE_BYTES } from "../../src/api/thread.js";
import { ProtocolError } from "../../src/api/validation.js";
import type { ThreadMessage, ThreadReadQuery } from "../../src/api/types.js";

const messageId = "10000000-0000-4000-8000-000000000001";
const secondId = "10000000-0000-4000-8000-000000000002";
const userId = "20000000-0000-4000-8000-000000000001";
const claimId = "30000000-0000-4000-8000-000000000001";
const workerId = "40000000-0000-4000-8000-000000000001";
const message: ThreadMessage = { id: messageId, author: { userId, displayName: "Alice", Agent: false }, body: " \t完整正文\n\n", createdAt: "2026-11-03T10:20:30.000Z" };
const query: ThreadReadQuery = { count: 20, details: false };
const page = (items: readonly unknown[]) => ({ items, hasMoreBefore: false, hasMoreAfter: false });
const goJson = (value: unknown): string => JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);

describe("Thread response fields", () => {
  it("preserves body whitespace and nullable or empty snapshot names", () => {
    expect(parseThreadMessage(message, false)).toEqual(message);
    for (const displayName of [null, "", "\uFEFF"]) {
      const value = { ...message, author: { ...message.author, displayName } };
      expect(parseThreadMessage(value, false)).toEqual(value);
    }
    expect(parseThreadMessage({ ...message, body: "\uFEFF" }, false).body).toBe("\uFEFF");
  });

  it("requires Agent execution only for a details resource", () => {
    const agent = { ...message, author: { ...message.author, Agent: true } };
    const details = { ...agent, author: { ...agent.author, execution: { claimId, workerId, provider: "codex" } } };
    expect(parseThreadMessage(agent, false)).toEqual(agent);
    expect(parseThreadMessage(details, true)).toEqual(details);
    for (const provider of ["codex", "claude", "copilot"]) {
      expect(parseThreadMessage({ ...details, author: { ...details.author, execution: { claimId, workerId, provider } } }, true).author.execution?.provider).toBe(provider);
    }
    expect(() => parseThreadMessage(agent, true)).toThrow(ProtocolError);
    expect(() => parseThreadMessage(details, false)).toThrow(ProtocolError);
    expect(() => parseThreadMessage({ ...details, author: { ...details.author, Agent: false } }, true)).toThrow(ProtocolError);
  });

  it("retains only an explicit valid reply reference", () => {
    expect(Object.hasOwn(parseThreadMessage(message, false), "replyTo")).toBe(false);
    expect(parseThreadMessage({ ...message, replyTo: secondId }, false).replyTo).toBe(secondId);
    for (const replyTo of [null, undefined, "bad", messageId]) expect(() => parseThreadMessage({ ...message, replyTo }, false)).toThrow(ProtocolError);
  });

  it.each([
    undefined, null, [], {}, { ...message, extra: true }, { ...message, id: "bad" },
    { ...message, id: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" },
    { ...message, body: "" }, { ...message, body: " \r\n\t" }, { ...message, body: "\0" }, { ...message, body: "\ud800" },
    { ...message, author: null }, { ...message, author: { ...message.author, Agent: null } },
    { ...message, author: { ...message.author, Agent: "false" } },
    { ...message, author: { userId, displayName: "Alice" } },
    { ...message, author: { userId, Agent: false } },
    { ...message, author: { ...message.author, extra: false } },
    ...Object.keys(message).map((key) => Object.fromEntries(Object.entries(message).filter(([field]) => field !== key))),
  ])("rejects malformed required fields %#", (value) => {
    expect(() => parseThreadMessage(value, false)).toThrow(ProtocolError);
  });

  it.each([null, {}, { claimId, workerId, provider: "other" }, { claimId, workerId, provider: "codex", extra: true }, { claimId, provider: "codex" }, { claimId: "bad", workerId, provider: "codex" }])("rejects malformed execution %#", (execution) => {
    expect(() => parseThreadMessage({ ...message, author: { ...message.author, Agent: true, execution } }, true)).toThrow(ProtocolError);
  });

  it.each(["2026-11-03T10:20:30.000Z", "2026-11-03T10:20:30.120Z", "2026-11-03T10:20:30.123Z"])("accepts exact UTC millisecond time %s", (createdAt) => {
    expect(parseThreadMessage({ ...message, createdAt }, false).createdAt).toBe(createdAt);
  });

  it.each(["2026-11-03T10:20:30Z", "2026-11-03T10:20:30.1Z", "2026-11-03T10:20:30.123000Z", "2026-11-03T10:20:30.123Z1", "2026-11-03T10:20:30.123+00:00", "2026-02-30T10:20:30.123Z", "2026-11-03T24:00:00.000Z"])("rejects imprecise or invalid time %s", (createdAt) => {
    expect(() => parseThreadMessage({ ...message, createdAt }, false)).toThrow(ProtocolError);
  });
});

describe("Thread page semantics", () => {
  it("accepts strict ascending same-millisecond IDs and both side markers", () => {
    const value = { ...page([message, { ...message, id: secondId }]), hasMoreBefore: true, hasMoreAfter: true };
    expect(parseThreadPage(value, query)).toEqual(value);
    expect(parseThreadPage(page([]), query)).toEqual(page([]));
  });

  it.each([
    { items: [], hasMoreBefore: true, hasMoreAfter: false }, { items: [], hasMoreBefore: false, hasMoreAfter: true },
    { items: [], hasMoreBefore: null, hasMoreAfter: false }, { items: [], hasMoreBefore: false },
    { ...page([]), nextCursor: null }, page([message, message]),
    page([{ ...message, id: secondId }, message]),
    page([{ ...message, createdAt: "2026-11-03T10:20:30.123Z" }, { ...message, id: secondId }]),
  ])("rejects malformed or noncontiguous ordering %#", (value) => {
    expect(() => parseThreadPage(value, query)).toThrow(ProtocolError);
  });

  it("rejects over-count pages and either excluded boundary ID", () => {
    expect(() => parseThreadPage(page([message, { ...message, id: secondId }]), { ...query, count: 1 })).toThrow(ProtocolError);
    for (const direction of ["beforeId", "afterId"]) expect(() => parseThreadPage(page([message]), { ...query, [direction]: messageId })).toThrow(ProtocolError);
    expect(() => parseThreadPage(page(Array.from({ length: 101 }, (_, index) => ({ ...message, id: `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}` }))), { ...query, count: 101 })).toThrow(ProtocolError);
  });
});

describe("Thread raw resource byte admission", () => {
  const sizedMessage = (bytes: number) => {
    const value = { ...message, body: "<>&\u2028\u2029".repeat(1_000) };
    const padding = bytes - new TextEncoder().encode(goJson(value)).byteLength;
    return goJson({ ...value, body: value.body + "a".repeat(padding) });
  };

  it("uses the complete original Go-escaped item at the exact 64 KiB boundary", () => {
    const source = sizedMessage(THREAD_MESSAGE_BYTES);
    expect(new TextEncoder().encode(source).byteLength).toBe(THREAD_MESSAGE_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(JSON.parse(source))).byteLength).toBeLessThan(THREAD_MESSAGE_BYTES);
    expect(parseThreadMessage(decodeThreadJsonSource(source, "message"), false).body).toBe(JSON.parse(source).body);
    const sourcePage = `{"items":[${source}],"hasMoreBefore":false,"hasMoreAfter":false}`;
    expect(parseThreadPage(decodeThreadJsonSource(sourcePage, "page"), query).items).toHaveLength(1);
  });

  it("rejects a 64 KiB plus one item even when the page itself fits", () => {
    const source = sizedMessage(THREAD_MESSAGE_BYTES + 1);
    expect(() => decodeThreadJsonSource(source, "message")).toThrow(ProtocolError);
    const sourcePage = `{"items":[${source}],"hasMoreBefore":false,"hasMoreAfter":false}`;
    expect(new TextEncoder().encode(sourcePage).byteLength).toBeLessThan(THREAD_PAGE_BYTES);
    expect(() => decodeThreadJsonSource(sourcePage, "page")).toThrow(ProtocolError);
  });

  it("includes Agent details in each raw item's 64 KiB admission", () => {
    const details = { ...message, body: "", author: { ...message.author, Agent: true, execution: { claimId, workerId, provider: "claude" } } };
    const source = goJson({ ...details, body: "a".repeat(THREAD_MESSAGE_BYTES - goJson(details).length) });
    const sourcePage = (item: string) => `{"items":[${item}],"hasMoreBefore":false,"hasMoreAfter":false}`;
    expect(parseThreadPage(decodeThreadJsonSource(sourcePage(source), "page"), { ...query, details: true }).items[0]?.author.execution).toEqual(details.author.execution);
    const oversized = source.replace('"body":"', '"body":"a');
    expect(() => decodeThreadJsonSource(sourcePage(oversized), "page")).toThrow(ProtocolError);
  });

  it("counts UTF-8 rather than UTF-16 source units", () => {
    const source = goJson({ ...message, body: "😀".repeat(17_000) });
    expect(source.length).toBeLessThan(THREAD_MESSAGE_BYTES);
    expect(() => decodeThreadJsonSource(source, "message")).toThrow(ProtocolError);
  });

  it("checks the complete page byte boundary independently", () => {
    const compact = goJson(page([]));
    const exact = compact + " ".repeat(THREAD_PAGE_BYTES - compact.length);
    expect(decodeThreadJsonSource(exact, "page")).toEqual(page([]));
    expect(() => decodeThreadJsonSource(exact + " ", "page")).toThrow(ProtocolError);
  });

  it.each([
    '{"items":[],"items":[],"hasMoreBefore":false,"hasMoreAfter":false}',
    goJson(page([message])).replace('"Agent":false', '"Agent":false,"\\u0041gent":true'),
    '{"error":{"code":"clock_not_advanced","code":"message_outcome_unknown","message":"failed","requestId":"r1"}}',
    '{"error":{"code":"forbidden","message":"failed","requestId":"r1","details":{"taskIds":[],"taskIds":[]}}}',
  ])("rejects duplicate source fields including errors %#", (source) => {
    expect(() => decodeThreadJsonSource(source, source.includes('"error"') ? "error" : "page")).toThrow(SyntaxError);
  });
});
