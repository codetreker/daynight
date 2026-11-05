import { ProtocolError } from "../../api/validation.js";
import type { ThreadMessage, ThreadPage } from "../../api/types.js";
import { terminalText } from "../../platform/terminal.js";

export const THREAD_OUTPUT_BYTES = 262_144;
export const MIN_THREAD_WIRE_FIXED_BYTES = 183;
export const MAX_THREAD_RENDER_FIXED_BYTES = 473;

const separator = "------------------------------";
const betweenMessages = `\n\n${separator}\n\n`;
const beforeNotice = "... Has more messages before";
const afterNotice = "Has more messages after...";
const bidi = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const unsafeBody = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u;
const unicodeEscape = (character: string): string => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;

export const encodeThreadBody = (value: string, singleLine = false): string => Array.from(value, (character) => {
  if (character === "\\") return "\\\\";
  if (character === "\r") return "\\r";
  if (character === "\u007f") return "\\x7f";
  if (singleLine && character === '"') return '\\"';
  return unsafeBody.test(character) || bidi.test(character) ? unicodeEscape(character) : character;
}).join("");

const encodeThreadLabel = (value: string): string => Array.from(value, (character) =>
  character === "\u007f" ? "\\x7f" : bidi.test(character) ? unicodeEscape(character) : terminalText(character),
).join("");

export const renderThreadMessage = (message: ThreadMessage): string => {
  const { author } = message;
  const name = author.displayName === null || author.displayName === "" ? "Account" : encodeThreadLabel(author.displayName);
  const execution = author.execution;
  const body = message.body.includes("\n")
    ? `Message:\n${encodeThreadBody(message.body).split("\n").map((line) => `  ${line}`).join("\n")}`
    : `Message: "${encodeThreadBody(message.body, true)}"`;
  return [
    `Id: ${message.id}`,
    `Author: ${name}${author.Agent ? "'s Agent" : ""} (${author.userId})`,
    ...(author.Agent ? ["Agent: True"] : []),
    `CreatedAt: ${message.createdAt}`,
    ...(message.replyTo === undefined ? [] : [`ReplyTo: ${message.replyTo}`]),
    ...(execution === undefined ? [] : [
      `Execution ClaimId: ${execution.claimId}`,
      `Execution WorkerId: ${execution.workerId}`,
      `Execution Provider: ${execution.provider}`,
    ]),
    body,
  ].join("\n");
};

const composePage = (blocks: readonly string[], before: boolean, after: boolean): string =>
  `${before ? `${beforeNotice}\n\n` : ""}${separator}\n\n${blocks.join(betweenMessages)}\n\n${separator}\n${after ? `\n${afterNotice}\n` : ""}`;

export const renderThreadPage = (
  page: ThreadPage,
  direction: "latest" | "before" | "after",
  check?: () => void,
): string => {
  check?.();
  if (page.items.length === 0) return direction === "after" ? "No new messages.\n" : "No messages.\n";
  const blocks = page.items.map((message) => {
    check?.();
    const block = renderThreadMessage(message);
    check?.();
    return block;
  });
  const prefixBytes = [0];
  for (const block of blocks) prefixBytes.push(prefixBytes[prefixBytes.length - 1]! + Buffer.byteLength(block, "utf8"));
  for (let count = blocks.length; count > 0; count--) {
    check?.();
    const start = direction === "after" ? 0 : blocks.length - count;
    const end = start + count;
    const before = page.hasMoreBefore || start > 0;
    const after = page.hasMoreAfter || end < blocks.length;
    const size = prefixBytes[end]! - prefixBytes[start]!
      + (count - 1) * Buffer.byteLength(betweenMessages, "utf8")
      + Buffer.byteLength(composePage([""], before, after), "utf8");
    if (size > THREAD_OUTPUT_BYTES) continue;
    const output = composePage(blocks.slice(start, end), before, after);
    if (Buffer.byteLength(output, "utf8") !== size) throw new ProtocolError("The thread output byte calculation is inconsistent.");
    check?.();
    return output;
  }
  throw new ProtocolError("A complete thread message exceeds the terminal output byte limit.");
};

export const renderThreadPostReceipt = (message: ThreadMessage): string =>
  `Message posted.\nId: ${message.id}\n${message.replyTo === undefined ? "" : `ReplyTo: ${message.replyTo}\n`}`;
