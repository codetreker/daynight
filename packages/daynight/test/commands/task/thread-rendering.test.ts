import { describe, expect, it, vi } from "vitest";
import type { ThreadMessage, ThreadPage } from "../../../src/api/types.js";
import {
  encodeThreadBody,
  renderThreadMessage,
  renderThreadPage,
  renderThreadPostReceipt,
} from "../../../src/commands/task/thread-rendering.js";

const account = "20000000-0000-4000-8000-000000000001";
const messageId = (index: number): string => `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
const message = (index = 1, body = "hello") => ({
  id: messageId(index), author: { userId: account, displayName: "Alice", Agent: false }, body, createdAt: "2026-11-03T10:20:30.000Z",
});
const page = (items: readonly ThreadMessage[], hasMoreBefore = false, hasMoreAfter = false): ThreadPage => ({ items, hasMoreBefore, hasMoreAfter });
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const decodeBody = (encoded: string): string => encoded.replace(/\\(\\|r|"|x7f|u[0-9a-f]{4})/gu, (_match, escape: string) => {
  if (escape === "\\" || escape === '"') return escape;
  if (escape === "r") return "\r";
  return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
});
const bodyFromBlock = (block: string): string => {
  const start = block.indexOf("\nMessage:");
  const wrapped = block.slice(start + "\nMessage:".length);
  return wrapped.startsWith("\n")
    ? decodeBody(wrapped.slice(1).split("\n").map((line) => line.slice(2)).join("\n"))
    : decodeBody(wrapped.slice(2, -1));
};

describe("thread readable message blocks", () => {
  it("prints complete identity, exact timestamp, reply and verified execution fields", () => {
    const item = { ...message(), replyTo: messageId(2), author: { userId: account, displayName: "Alice", Agent: true, execution: { claimId: messageId(3), workerId: messageId(4), provider: "copilot" as const } } };
    expect(renderThreadMessage(item)).toBe([
      `Id: ${item.id}`, `Author: Alice's Agent (${account})`, "Agent: True", "CreatedAt: 2026-11-03T10:20:30.000Z", `ReplyTo: ${messageId(2)}`,
      `Execution ClaimId: ${messageId(3)}`, `Execution WorkerId: ${messageId(4)}`, "Execution Provider: copilot", 'Message: "hello"',
    ].join("\n"));
    const ordinary = renderThreadMessage(message());
    expect(ordinary).not.toContain("Agent:");
    expect(ordinary).not.toContain("Execution");
    expect(ordinary).not.toContain("ReplyTo:");
  });

  it.each([null, ""])("presents an unnamed account explicitly: %s", (displayName) => {
    expect(renderThreadMessage({ ...message(), author: { userId: account, displayName, Agent: false } })).toContain(`Author: Account (${account})`);
    expect(renderThreadMessage({ ...message(), author: { userId: account, displayName, Agent: true } })).toContain(`Author: Account's Agent (${account})`);
  });

  it("keeps hostile labels on one line and leaves literal escape text intact", () => {
    const label = "Name\nId: fake\t\u007f\u009b\u202e (other) \\u007f";
    const output = renderThreadMessage({ ...message(), author: { userId: account, displayName: label, Agent: false } });
    expect(output.split("\n").find((line) => line.startsWith("Author:"))).toBe(`Author: Name\\nId: fake\\t\\x7f\\u009b\\u202e (other) \\u007f (${account})`);
    expect(output.match(/^Id:/gmu)).toHaveLength(1);
  });

  it.each([
    "  plain text  ", 'quotes " and \\r \\u001b \\x7f', "\t中文😀\r\u001b[31m\u007f\u0085\u009b\u2028\u2029\u061c\u200f\u202e\u2066",
    "\n\t first \r\n\nId: forged\n------------------------------\nHas more messages after...\n", "```typescript\nconst value = \\\"text\\\";\n```\n",
  ])("round trips the complete body without losing whitespace: %j", (body) => {
    expect(bodyFromBlock(renderThreadMessage(message(1, body)))).toBe(body);
    expect(decodeBody(encodeThreadBody(body))).toBe(body);
  });

  it("encodes actual controls differently from literal escape prefixes", () => {
    expect(encodeThreadBody("\u001b\\u001b\u007f\\x7f")).toBe("\\u001b\\\\u001b\\x7f\\\\x7f");
    const block = renderThreadMessage(message(1, "\nId: forged\n------------------------------\n... Has more messages before\n"));
    expect(block).toContain("\n  Id: forged\n  ------------------------------\n  ... Has more messages before\n  ");
    expect(block.match(/^Id:/gmu)).toHaveLength(1);
  });

  it("prints only the confirmed post identity and optional reply", () => {
    expect(renderThreadPostReceipt(message())).toBe(`Message posted.\nId: ${messageId(1)}\n`);
    expect(renderThreadPostReceipt({ ...message(), replyTo: messageId(2) })).toBe(`Message posted.\nId: ${messageId(1)}\nReplyTo: ${messageId(2)}\n`);
    expect(renderThreadPostReceipt(message())).not.toContain("hello");
  });
});

describe("thread page boundaries", () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])("keeps directional notices outside message blocks: %s/%s", (before, after) => {
    const output = renderThreadPage(page([message(1), message(2)], before, after), "latest");
    expect(output.startsWith("... Has more messages before\n\n")).toBe(before);
    expect(output.endsWith("\nHas more messages after...\n")).toBe(after);
    expect(output.indexOf(messageId(1))).toBeLessThan(output.indexOf(messageId(2)));
    expect(output.endsWith("\n")).toBe(true);
  });

  it.each(["latest", "before", "after"] as const)("reports an empty %s page without inventing a position", (direction) => {
    expect(renderThreadPage(page([]), direction)).toBe(direction === "after" ? "No new messages.\n" : "No messages.\n");
  });

  it.each(["\u007f", "\u0085", "\b", "\n", "\t", "\\", "中文😀"])("fits a complete legal 64 KiB resource with dense %j data", (unit) => {
    const item = { ...message(1, "x"), replyTo: messageId(2), author: { userId: account, displayName: unit.repeat(15), Agent: true, execution: { claimId: messageId(3), workerId: messageId(4), provider: "copilot" as const } } };
    const remaining = 65_536 - bytes(JSON.stringify(item));
    item.body += unit.repeat(Math.floor(remaining / (bytes(JSON.stringify(unit)) - 2)));
    item.body += "a".repeat(65_536 - bytes(JSON.stringify(item)));
    expect(bytes(JSON.stringify(item))).toBe(65_536);
    const output = renderThreadPage(page([item], true, true), "latest");
    expect(bodyFromBlock(renderThreadMessage(item))).toBe(item.body);
    expect(output).toContain(renderThreadMessage(item));
  });

  it.each(["latest", "before", "after"] as const)("renders every count-selected message in a large %s page", (direction) => {
    const items = Array.from({ length: 4 }, (_, index) => {
      const item = message(index + 1, "\u007f".repeat(1_000));
      return { ...item, body: item.body + "a".repeat(65_536 - bytes(JSON.stringify(item))) };
    });
    const output = renderThreadPage(page(items), direction);
    expect(bytes(output)).toBeGreaterThan(262_144);
    expect(output.match(/^Id: .+$/gmu)).toEqual(items.map(item => `Id: ${item.id}`));
    for (const item of items) expect(output).toContain(renderThreadMessage(item));
    expect(output).not.toContain("Has more messages");
  });

  it("propagates cancellation before output", () => {
    const failure = new Error("cancelled");
    const check = vi.fn(() => { if (check.mock.calls.length === 3) throw failure; });
    expect(() => renderThreadPage(page([message(1), message(2)]), "after", check)).toThrow(failure);
  });
});
