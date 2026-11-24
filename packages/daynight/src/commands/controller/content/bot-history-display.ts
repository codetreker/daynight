import { sessionArchiveReferences } from "../../../session/archive.js";
import { BOT_HISTORY_WINDOW_PREVIEW_BYTES, type BotHistoryWindowEntry, type BotHistoryWindowTool } from "../../../session/bot-history-window.js";
import type { MessagePart, TimelineEntry } from "../../../session/protocol.js";

export type BotDisplayEntry = Extract<TimelineEntry, { kind: "user_message" | "assistant_message" | "tool_call" }>;
export const isBotDisplayEntry = <T extends { kind: string }>(entry: T): entry is Extract<T, { kind: BotDisplayEntry["kind"] }> =>
  entry.kind === "user_message" || entry.kind === "assistant_message" || entry.kind === "tool_call";

const ellipsis = "…";
const textBytes = (text: string): number => Buffer.byteLength(text);

export const clipBotText = (text: string, limit: number): string => {
  if (textBytes(text) <= limit) return text;
  if (limit < textBytes(ellipsis)) return "";
  let used = textBytes(ellipsis), end = 0;
  for (const character of text) {
    used += textBytes(character);
    if (used > limit) break;
    end += character.length;
  }
  return text.slice(0, end) + ellipsis;
};

const toolMetadata = (entry: Extract<BotDisplayEntry, { kind: "tool_call" }>): BotHistoryWindowTool => {
  let args: unknown;
  if (entry.input.startsWith("{") && textBytes(entry.input) <= 64 * 1024) {
    try { args = JSON.parse(entry.input); } catch { /* The Provider also supplies plain command strings. */ }
  }
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const command = record.command ?? record.cmd;
  const directory = record.cwd ?? record.workdir;
  const exitCode = record.exitCode;
  const field = (value: string, limit: number): string => clipBotText(value.toWellFormed().replaceAll("\0", "\uFFFD"), limit);
  return {
    toolName: clipBotText(entry.name, 256),
    command: typeof command === "string" ? field(command, 8192) : /^(command_?execution|exec_command|bash|shell|terminal)$/i.test(entry.name) && args === undefined ? field(entry.input, 8192) : null,
    cwd: typeof directory === "string" && directory ? field(directory, 4096) : null,
    status: entry.status,
    exitCode: typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode >= -2147483648 && exitCode <= 2147483647 ? exitCode : null,
  };
};

const bodyText = (parts: readonly MessagePart[]): string => parts.flatMap(part => part.type === "text" || part.type === "markdown" ? [part.text] : []).join("\n");

export const fitsBotMarkdown = (entry: { kind: string; content?: readonly MessagePart[]; output?: readonly MessagePart[] }): boolean =>
  (entry.kind === "user_message" || entry.kind === "assistant_message" || entry.kind === "tool_call")
  && textBytes(bodyText(entry.content ?? entry.output ?? [])) <= BOT_HISTORY_WINDOW_PREVIEW_BYTES;

const clipBody = (parts: readonly MessagePart[], limit: number): readonly MessagePart[] => {
  let remaining = limit;
  return parts.map(part => {
    if (part.type !== "text" && part.type !== "markdown") return part;
    const text = clipBotText(part.text, remaining);
    remaining -= textBytes(text);
    return text === part.text ? part : { type: "text", text };
  });
};

export const projectBotDisplay = (entry: BotDisplayEntry, limit = BOT_HISTORY_WINDOW_PREVIEW_BYTES): { durable: BotDisplayEntry; preview: BotHistoryWindowEntry } => {
  const parts = entry.kind === "tool_call" ? entry.output : entry.content;
  const original = bodyText(parts);
  const preview = clipBotText(original, limit);
  const body = clipBody(parts, limit);
  const durable = entry.kind === "tool_call"
    ? { ...entry, name: clipBotText(entry.name, 256), input: clipBotText(entry.input, Math.min(8192, limit)), output: body, truncated: entry.truncated || original !== preview || textBytes(entry.input) > Math.min(8192, limit) }
    : { ...entry, content: body };
  const tool = entry.kind === "tool_call" ? toolMetadata(entry) : null;
  const providerLimited = entry.kind === "tool_call" && entry.truncated;
  const truncated = original !== preview || durable.kind === "tool_call" && durable.truncated;
  return {
    durable,
    preview: {
      entryId: entry.entryId, entrySeq: entry.entrySeq, revision: entry.revision, kind: entry.kind,
      preview, truncated, originalBytes: providerLimited ? null : String(textBytes(original)), previewBytes: String(textBytes(preview)),
      omissionReason: truncated ? "preview_limit" : null, omittedEntryCount: 0,
      resourceIds: [...sessionArchiveReferences([durable], false).resources].sort(), tool,
    },
  };
};
