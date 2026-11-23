import { ArchiveRequestError } from "./archive-error.js";

export const ARCHIVE_ROUND_TIMEOUT_MS = 60_000;
export const ARCHIVE_STREAM_ROUND_TIMEOUT_MS = 35 * 60_000;
export const ARCHIVE_REQUEST_TIMEOUT_MS = 15_000;
export const ARCHIVE_STREAM_TIMEOUT_MS = 30 * 60_000;
export const ARCHIVE_MAX_RETRIES = 8;
export const ARCHIVE_ERROR_MAX_BYTES = 65_536;

export type ArchiveRetryRuntime = {
  now(): number;
  random(): number;
  wait(ms: number, signal: AbortSignal): Promise<void>;
};
export type ArchiveRetryEvent = {
  phase: "waiting" | "exhausted";
  retry: number;
  delayMs: number | null;
  classification: "resource_busy";
  requestId: string | null;
  sessionId: string;
};

/** Waits under the caller's cancellation ownership and releases its timer/listener. */
export const waitForArchiveRetry = async (ms: number, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
};

export const archiveRetryRuntime: ArchiveRetryRuntime = {
  now: () => Date.now(),
  random: () => Math.random(),
  wait: waitForArchiveRetry,
};

const retryAfterDelay = (value: string | null, now: number): number | null => {
  if (value === null) return null;
  const hint = value.trim();
  if (/^\d+$/.test(hint)) return Number(hint) * 1000;
  // HTTP dates include IMF-fixdate and the two obsolete forms accepted by HTTP.
  if (!/^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(hint)) return null;
  const date = Date.parse(hint);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
};

/** A one-based retry samples independently; null preserves the last capacity error. */
export const archiveRetryDelay = (options: {
  retry: number; retryAfter: string | null; now: number; random(): number; remainingMs: number;
}): number | null => {
  if (!Number.isSafeInteger(options.retry) || options.retry < 1) throw new RangeError("Archive retry number must be a positive integer.");
  const sample = options.random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new RangeError("Archive retry random sample must be between zero and one.");
  const baseline = Math.min(10_000, 1000 * 2 ** Math.min(options.retry - 1, 4));
  const sampled = baseline * 0.8 + baseline * 0.4 * sample;
  const hint = retryAfterDelay(options.retryAfter, options.now);
  const delay = hint === null ? sampled : Math.max(sampled, hint);
  return delay > 12_000 || delay > options.remainingMs ? null : delay;
};

const readWithSignal = async (reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<Awaited<ReturnType<typeof reader.read>>> => {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([reader.read(), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
};

/** Only a bounded structured error can classify a capacity refusal; I/O failures propagate. */
export const readArchiveRequestError = async (response: Response, signal: AbortSignal): Promise<ArchiveRequestError> => {
  const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
  let length = 0, oversized = false;
  if (reader) try {
    for (;;) {
      const part = await readWithSignal(reader, signal);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > ARCHIVE_ERROR_MAX_BYTES) { oversized = true; break; }
      chunks.push(part.value);
    }
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  signal.throwIfAborted();
  if (oversized) return new ArchiveRequestError(response.status, undefined);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
    return new ArchiveRequestError(response.status, undefined);
  }
  const detail = payload !== null && typeof payload === "object" && !Array.isArray(payload) && "error" in payload ? payload.error : undefined;
  const code = detail !== null && typeof detail === "object" && !Array.isArray(detail) && "code" in detail && typeof detail.code === "string" ? detail.code : undefined;
  return new ArchiveRequestError(response.status, code, payload, response.headers.get("Daynight-Archive-Upload-Version"));
};
