import { parseApiJson } from "./json.js";
import { jsonObjectSources } from "./json-source.js";
import { array, bool, fields, id, malformed, text } from "./validation.js";
import type { ThreadAuthor, ThreadExecution, ThreadMessage, ThreadPage, ThreadReadQuery } from "./types.js";

export const THREAD_MESSAGE_BYTES = 65_536;
export const decodeThreadJsonSource = (source: string): unknown => {
  jsonObjectSources(source);
  return parseApiJson(source);
};

const execution = (value: unknown): ThreadExecution => {
  const data = fields(value, ["claimId", "workerId", "provider"]);
  const provider = data.provider;
  if (provider !== "codex" && provider !== "claude" && provider !== "copilot") return malformed();
  return { claimId: id(data.claimId), workerId: id(data.workerId), provider };
};

const author = (value: unknown, details: boolean): ThreadAuthor => {
  const data = fields(value, ["userId", "displayName", "Agent", "execution"]);
  const parsed: ThreadAuthor = { userId: id(data.userId), displayName: data.displayName === null ? null : text(data.displayName), Agent: bool(data.Agent) };
  const hasExecution = Object.hasOwn(data, "execution");
  if (details && parsed.Agent) {
    if (!hasExecution) return malformed();
    return { ...parsed, execution: execution(data.execution) };
  }
  if (hasExecution) return malformed();
  return parsed;
};

const createdAt = (value: unknown): string => {
  const parsed = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)) return malformed();
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed) return malformed();
  return parsed;
};

export const parseThreadMessage = (value: unknown, details: boolean): ThreadMessage => {
  const data = fields(value, ["id", "author", "body", "createdAt", "replyTo"]);
  const parsed: ThreadMessage = { id: id(data.id), author: author(data.author, details), body: text(data.body, true), createdAt: createdAt(data.createdAt) };
  if (!Object.hasOwn(data, "replyTo")) return parsed;
  const replyTo = id(data.replyTo);
  if (replyTo === parsed.id) return malformed();
  return { ...parsed, replyTo };
};

export const parseThreadPage = (value: unknown, query: ThreadReadQuery): ThreadPage => {
  const data = fields(value, ["items", "hasMoreBefore", "hasMoreAfter"]);
  const items = array(data.items, (item) => parseThreadMessage(item, query.details));
  const hasMoreBefore = bool(data.hasMoreBefore), hasMoreAfter = bool(data.hasMoreAfter);
  if (items.length > query.count || items.length > 100 || items.length === 0 && (hasMoreBefore || hasMoreAfter)) return malformed();
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id) || item.id === query.beforeId || item.id === query.afterId) return malformed();
    seen.add(item.id);
    const previous = items[index - 1];
    if (previous !== undefined && (previous.createdAt > item.createdAt || previous.createdAt === item.createdAt && previous.id >= item.id)) return malformed();
  }
  return { items, hasMoreBefore, hasMoreAfter };
};
