import type { AssistantTaskEvent } from "../../../api/assistant-task.js";
import { decodeInboundPayload, INBOUND_EVENT_TYPE } from "./assistant-task-inbound.js";

/** Each appendix preview is at most this many UTF-8 bytes, including its truncation mark. */
export const EXPERIENCE_SUMMARY_BYTES = 1024;
/** The server returns at most five related appendices; a longer reply is cut to the same bound. */
export const EXPERIENCE_ITEMS = 5;
/**
 * Server requests one batch may spend on experience, counting item reads and
 * related-experience queries alike, whether they succeed or fail. Contexts
 * left once it is spent get no summary.
 */
export const EXPERIENCE_REQUESTS = 10;
/**
 * Wall-clock bound for all experience requests of one batch. When it expires,
 * the in-flight request is aborted and the remaining contexts get no summary,
 * so a slow server delays the notification by at most this long.
 */
export const EXPERIENCE_TIME_MS = 10_000;

export type ExperienceQuery = { projectId?: string; eventType: string; itemCategory?: string };
export type RelatedAppendix = { id: string; text: string };
/**
 * Reads used to attach experience; every failure degrades to no summary for
 * that context. Each read must stop when its signal aborts.
 */
export type ExperienceSource = {
  itemCategory(taskId: string, itemId: string, signal: AbortSignal): Promise<string>;
  related(taskId: string, query: ExperienceQuery, signal: AbortSignal): Promise<readonly RelatedAppendix[]>;
};

const unread = Symbol("unread");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mark = "…";
const title = "\n相关经验（附录只是经验参考，不是手册规则，也不是额外授权；摘要可能截短，执行前须阅读完整附录）：";
const size = (pieces: readonly string[]) => pieces.reduce((total, piece) => total + Buffer.byteLength(piece) + 1, 0);

/** Collapses whitespace so an appendix stays on one line, then cuts it on a code point boundary. */
export const experiencePreview = (text: string): string => {
  const flat = text.toWellFormed().replace(/\s+/gu, " ").trim();
  if (Buffer.byteLength(flat) <= EXPERIENCE_SUMMARY_BYTES) return flat;
  const limit = EXPERIENCE_SUMMARY_BYTES - Buffer.byteLength(mark);
  let bytes = 0, end = 0;
  for (const char of flat) {
    const next = bytes + Buffer.byteLength(char);
    if (next > limit) break;
    bytes = next; end += char.length;
  }
  return flat.slice(0, end) + mark;
};

const payloadField = (event: AssistantTaskEvent, name: string): unknown =>
  event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload[name] : undefined;
const projectOf = (event: AssistantTaskEvent): string | undefined => {
  if (event.type === INBOUND_EVENT_TYPE) {
    const inbound = decodeInboundPayload(event.payload);
    return inbound?.classification === "daynight" ? inbound.projectId : undefined;
  }
  const value = payloadField(event, "projectId");
  return typeof value === "string" && uuid.test(value) ? value : undefined;
};
const itemOf = (event: AssistantTaskEvent): string | undefined => {
  const value = payloadField(event, "itemId");
  return typeof value === "string" && uuid.test(value) ? value : undefined;
};
const describe = (taskId: string, query: ExperienceQuery) =>
  `助手任务 ${taskId}；事件类型 ${query.eventType}${query.projectId === undefined ? "" : `；项目 ${query.projectId}`}${query.itemCategory === undefined ? "" : `；事项类别 ${JSON.stringify(query.itemCategory)}`}：`;
// Event types and project IDs are server-validated tokens; a category is free text and is always quoted.
const shellWord = (value: string) => /^[A-Za-z0-9_.:-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
const readCommand = (taskId: string, query: ExperienceQuery) =>
  `  完整附录：daynight assistant-task appendix related ${taskId} --event-type ${shellWord(query.eventType)}${query.projectId === undefined ? "" : ` --project ${query.projectId}`}${query.itemCategory === undefined ? "" : ` --category ${shellWord(query.itemCategory)}`}`;

type Context = { taskId: string; eventType: string; projectId?: string; itemId?: string };

/**
 * Builds the related experience section for the delivered events. Contexts
 * are deduplicated by task, project, event type and item before any read, so
 * repeated events cost nothing. Contexts are then processed in event order:
 * a distinct item is read once to learn its category, and each distinct
 * query runs once. Every request, failed or not, spends one of
 * EXPERIENCE_REQUESTS, and all of them share EXPERIENCE_TIME_MS; once either
 * budget is spent the remaining contexts get no summary. A failed item read
 * skips that context without querying experience, and a failed experience
 * read leaves it without a summary; neither fails the batch, and only
 * cancellation of signal propagates. Whole context sections that would exceed
 * the byte budget are omitted, so the returned pieces fit within budget bytes
 * when each piece is joined by one newline.
 */
export const relatedExperience = async (events: readonly AssistantTaskEvent[], source: ExperienceSource, budget: number, signal: AbortSignal): Promise<string[]> => {
  const contexts = new Map<string, Context>();
  for (const event of events) {
    const projectId = projectOf(event), itemId = itemOf(event);
    const context: Context = { taskId: event.taskId, eventType: event.type, ...(projectId === undefined ? {} : { projectId }), ...(itemId === undefined ? {} : { itemId }) };
    const key = JSON.stringify([context.taskId, context.projectId ?? null, context.eventType, context.itemId ?? null]);
    if (!contexts.has(key)) contexts.set(key, context);
  }
  signal.throwIfAborted();
  // An owned timer is cleared as soon as the reads finish instead of
  // outliving the batch like AbortSignal.timeout.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Experience time budget exhausted.")), EXPERIENCE_TIME_MS);
  const requestSignal = AbortSignal.any([signal, deadline.signal]);
  let requests = 0;
  // Returns undefined for a failed or unstarted request. The race stops
  // waiting at the deadline even if a source ignores its signal.
  const attempt = async <T>(read: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    if (requests >= EXPERIENCE_REQUESTS || requestSignal.aborted) return undefined;
    requests++;
    let stop: () => void = () => undefined;
    const stopped = new Promise<undefined>(resolve => { stop = () => resolve(undefined); requestSignal.addEventListener("abort", stop, { once: true }); });
    try { return await Promise.race([read(requestSignal), stopped]); }
    catch { return undefined; }
    finally { requestSignal.removeEventListener("abort", stop); signal.throwIfAborted(); }
  };
  const categories = new Map<string, string | typeof unread>(), queried = new Set<string>(), sections: string[][] = [];
  try {
    for (const context of contexts.values()) {
      if (requests >= EXPERIENCE_REQUESTS || requestSignal.aborted) break;
      let itemCategory: string | undefined;
      if (context.itemId !== undefined) {
        const itemKey = `${context.taskId}/${context.itemId}`, itemId = context.itemId;
        let read = categories.get(itemKey);
        if (read === undefined) { read = await attempt(requestSignal => source.itemCategory(context.taskId, itemId, requestSignal)) ?? unread; categories.set(itemKey, read); }
        // Querying without the category would let the server match appendices
        // scoped to any category, so an unreadable item gets no summary at all.
        if (read === unread) continue;
        itemCategory = read || undefined;
      }
      const query: ExperienceQuery = { eventType: context.eventType, ...(context.projectId === undefined ? {} : { projectId: context.projectId }), ...(itemCategory === undefined ? {} : { itemCategory }) };
      const key = JSON.stringify([context.taskId, query.projectId ?? null, query.eventType, query.itemCategory ?? null]);
      if (queried.has(key)) continue;
      queried.add(key);
      const found = await attempt(requestSignal => source.related(context.taskId, query, requestSignal));
      if (!found?.length) continue;
      sections.push([describe(context.taskId, query), ...found.slice(0, EXPERIENCE_ITEMS).map(item => `- 附录 ${item.id}：${experiencePreview(item.text)}`), readCommand(context.taskId, query)]);
    }
  } finally { clearTimeout(timer); }
  const pieces: string[] = [];
  let used = size([title]);
  for (const section of sections) {
    const added = size(section);
    if (used + added > budget) continue;
    pieces.push(...section); used += added;
  }
  return pieces.length ? [title, ...pieces] : [];
};
