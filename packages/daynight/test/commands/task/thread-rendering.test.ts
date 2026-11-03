import { describe, expect, it, vi } from "vitest";
import type { ThreadMessage, ThreadPage } from "../../../src/api/types.js";
import {
  encodeThreadBody,
  MAX_THREAD_RENDER_FIXED_BYTES,
  MIN_THREAD_WIRE_FIXED_BYTES,
  renderThreadMessage,
  renderThreadPage,
  renderThreadPostReceipt,
  THREAD_OUTPUT_BYTES,
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

describe("thread page boundaries and byte budgets", () => {
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

  it("enforces the fixed wire and rendered costs used by the single-message proof", () => {
    const shortest = { ...message(1, ""), author: { userId: account, displayName: "", Agent: true } };
    expect(bytes(JSON.stringify(shortest))).toBe(MIN_THREAD_WIRE_FIXED_BYTES);
    expect(MIN_THREAD_WIRE_FIXED_BYTES).toBe(183);
    const longest = { ...shortest, replyTo: messageId(2), author: { userId: account, displayName: null, Agent: true, execution: { claimId: messageId(3), workerId: messageId(4), provider: "copilot" as const } } };
    expect(bytes(renderThreadPage(page([longest], true, true), "latest"))).toBe(MAX_THREAD_RENDER_FIXED_BYTES);
    expect(MAX_THREAD_RENDER_FIXED_BYTES).toBe(473);
    expect(MAX_THREAD_RENDER_FIXED_BYTES).toBeLessThanOrEqual(4 * MIN_THREAD_WIRE_FIXED_BYTES);
    for (const Agent of [false, true]) {
      for (const displayName of ["", null]) {
        for (const replyTo of [undefined, messageId(2)]) {
          for (const provider of [undefined, "codex", "claude", "copilot"] as const) {
            if (!Agent && provider !== undefined) continue;
            const item: ThreadMessage = {
              ...shortest,
              ...(replyTo === undefined ? {} : { replyTo }),
              author: {
                userId: account, displayName, Agent,
                ...(provider === undefined ? {} : { execution: { claimId: messageId(3), workerId: messageId(4), provider } }),
              },
            };
            expect(bytes(JSON.stringify(item))).toBeGreaterThanOrEqual(MIN_THREAD_WIRE_FIXED_BYTES);
            expect(bytes(renderThreadPage(page([item], true, true), "latest"))).toBeLessThanOrEqual(MAX_THREAD_RENDER_FIXED_BYTES);
          }
        }
      }
    }
  });

  it.each(["\u007f", "\u0085", "\b", "\n", "\t", "\\", "中文😀"])("fits a complete legal 64 KiB resource with dense %j data", (unit) => {
    const item = { ...message(1, "x"), replyTo: messageId(2), author: { userId: account, displayName: unit.repeat(15), Agent: true, execution: { claimId: messageId(3), workerId: messageId(4), provider: "copilot" as const } } };
    const remaining = 65_536 - bytes(JSON.stringify(item));
    item.body += unit.repeat(Math.floor(remaining / (bytes(JSON.stringify(unit)) - 2)));
    item.body += "a".repeat(65_536 - bytes(JSON.stringify(item)));
    expect(bytes(JSON.stringify(item))).toBe(65_536);
    const output = renderThreadPage(page([item], true, true), "latest");
    expect(bytes(output)).toBeLessThanOrEqual(THREAD_OUTPUT_BYTES);
    expect(bodyFromBlock(renderThreadMessage(item))).toBe(item.body);
    expect(output).toContain(renderThreadMessage(item));
  });

  it("includes a page at the exact output boundary and moves a complete message at one byte over", () => {
    const items = [message(1, "a"), message(2, "b")];
    const available = THREAD_OUTPUT_BYTES - bytes(renderThreadPage(page(items), "after"));
    const controls = Math.floor(available / 8);
    items[0]!.body += "\u007f".repeat(controls) + "x".repeat(available % 8);
    items[1]!.body += "\u007f".repeat(controls);
    expect(items.every((item) => bytes(JSON.stringify(item)) <= 65_536)).toBe(true);
    expect(bytes(renderThreadPage(page(items), "after"))).toBe(THREAD_OUTPUT_BYTES);
    items[1]!.body += "x";
    const after = renderThreadPage(page(items), "after");
    expect(after).toContain(renderThreadMessage(items[0]!));
    expect(after).not.toContain(`Id: ${messageId(2)}\n`);
    expect(after).toContain("Has more messages after...\n");
    const before = renderThreadPage(page(items), "before");
    expect(before).not.toContain(`Id: ${messageId(1)}\n`);
    expect(before).toContain(renderThreadMessage(items[1]!));
    expect(before.startsWith("... Has more messages before\n\n")).toBe(true);
    expect(renderThreadPage(page(items), "latest")).toBe(before);
    expect(bytes(after)).toBeLessThan(THREAD_OUTPUT_BYTES);
    expect(bytes(before)).toBeLessThan(THREAD_OUTPUT_BYTES);
  });

  it("selects a contiguous directional subset and combines server and local notices", () => {
    const items = Array.from({ length: 5 }, (_, index) => message(index + 1, "\u007f".repeat(30_000)));
    const after = renderThreadPage(page(items, true, false), "after");
    expect(after.match(/^Id: .+$/gmu)).toEqual([`Id: ${messageId(1)}`, `Id: ${messageId(2)}`]);
    expect(after.startsWith("... Has more messages before")).toBe(true);
    expect(after.endsWith("Has more messages after...\n")).toBe(true);
    const before = renderThreadPage(page(items, false, true), "before");
    expect(before.match(/^Id: .+$/gmu)).toEqual([`Id: ${messageId(4)}`, `Id: ${messageId(5)}`]);
    expect(before.startsWith("... Has more messages before")).toBe(true);
    expect(before.endsWith("Has more messages after...\n")).toBe(true);
    for (const item of items.slice(3)) expect(before).toContain(renderThreadMessage(item));
  });

  it("propagates cancellation and refuses an impossible nonconforming message without output", () => {
    const failure = new Error("cancelled");
    const check = vi.fn(() => { if (check.mock.calls.length === 3) throw failure; });
    expect(() => renderThreadPage(page([message(1), message(2)]), "after", check)).toThrow(failure);
    expect(() => renderThreadPage(page([message(1, "a".repeat(THREAD_OUTPUT_BYTES))]), "latest")).toThrow("A complete thread message exceeds the terminal output byte limit.");
  });
});
