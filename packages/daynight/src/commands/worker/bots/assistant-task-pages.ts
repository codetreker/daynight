import type { AssistantTaskPage, AssistantTaskQuery } from "../../../api/assistant-task.js";

// Each REST input is at most 1 MiB. A task can retain application, name, purpose,
// scope and trigger from separate inputs; HTML escaping expands each at most 6x.
// A single task and its envelope therefore fit 32 MiB. A renewal uses at most
// five task GETs, so its independent 256 MiB budget also covers claim receipts.
export const ASSISTANT_TASK_RESPONSE_BYTES = 32 * 1024 * 1024;
export const ASSISTANT_TASK_OPERATION_BYTES = 256 * 1024 * 1024;

type PageReader<T> = (query: AssistantTaskQuery) => Promise<AssistantTaskPage<T>>;

/**
 * Read one task or event per page and retain no previous payloads.
 * The reader owns a fresh bounded API operation for each page, so historical
 * volume cannot exhaust the cumulative budget of a later acknowledgment.
 * Consumers stop iteration once their batch or lookup is complete.
 */
export async function* assistantTaskPages<T>(
  readPage: PageReader<T>,
  query: Omit<AssistantTaskQuery, "limit" | "cursor"> = {},
): AsyncGenerator<T> {
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await readPage({ ...query, limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    if (page.items.length > 1) throw new Error("Assistant task page exceeded its requested size.");
    if (page.nextCursor !== null && cursors.has(page.nextCursor)) throw new Error("Assistant task pagination repeated a cursor.");
    for (const item of page.items) yield item;
    if (page.nextCursor === null) return;
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
