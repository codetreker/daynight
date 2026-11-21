import { decodeStrictJson } from '../../../daynight/src/strict-json';
import { ApiError, assertResponsePrincipal, authRequestLifetime, json, readAuthRequestGeneration, request, responseSignal } from './client';

const ERROR_LIMIT = 64 * 1024;
const MAX_RETRIES = 4;
const BUDGET_MS = 30_000;

async function errorBytes(response: Response, signal: AbortSignal): Promise<unknown> {
  const lifetime = responseSignal(response, signal);
  lifetime.throwIfAborted();
  if (!response.body) throw new Error('Missing error body');
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(ERROR_LIMIT))) {
    void response.body.cancel().catch(() => undefined);
    throw new Error('Error body exceeds limit');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel(lifetime.reason).catch(() => undefined); };
  lifetime.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const part = await reader.read();
      lifetime.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > ERROR_LIMIT) throw new Error('Error body exceeds limit');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return decodeStrictJson(bytes, ERROR_LIMIT);
  } finally {
    lifetime.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function retryAfter(value: string | null): number | null {
  if (value === null) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const fullWeekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const modern = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const rfc850 = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const asctime = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
  let weekday: number, day: number, month: number, year: number, hour: number, minute: number, second: number;
  if (modern || rfc850) {
    const m = (modern ?? rfc850)!;
    weekday = (modern ? weekdays : fullWeekdays).indexOf(m[1]!);
    day = Number(m[2]); month = months.indexOf(m[3]!); year = Number(m[4]);
    if (rfc850) {
      const currentYear = new Date().getUTCFullYear();
      year += Math.floor(currentYear / 100) * 100;
      if (year > currentYear + 50) year -= 100;
    }
    hour = Number(m[5]); minute = Number(m[6]); second = Number(m[7]);
  } else if (asctime) {
    weekday = weekdays.indexOf(asctime[1]!); month = months.indexOf(asctime[2]!); day = Number(asctime[3]);
    hour = Number(asctime[4]); minute = Number(asctime[5]); second = Number(asctime[6]); year = Number(asctime[7]);
  } else return null;
  if (month < 0 || hour > 23 || minute > 59 || second > 60) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day || date.getUTCDay() !== weekday) return null;
  return Math.max(0, date.getTime() + (second === 60 ? 1000 : 0) - Date.now());
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function archiveRetryDelay(attempt: number, random: number): number {
  return Math.min(10_000, 1000 * 2 ** attempt) * (0.8 + random * 0.4);
}

/** One archive load shares its retry budget and original authentication lifetime. */
export function createArchiveReadRetry(signal: AbortSignal, userId: string, onPrincipalMismatch: () => void, sessionId: string) {
  const generation = readAuthRequestGeneration();
  let lifetime = authRequestLifetime(signal);
  let firstBusy: number | null = null;
  let retries = 0;
  const assertCurrent = () => {
    lifetime.throwIfAborted();
    if (generation !== readAuthRequestGeneration()) throw new DOMException('The authenticated account changed.', 'AbortError');
  };
  const get = async (url: string, init: RequestInit, phase: 'content' | 'timeline'): Promise<Response> => {
    let attempt = 0;
    for (;;) {
      assertCurrent();
      const response = await request(url, lifetime, init);
      lifetime = responseSignal(response, lifetime);
      assertCurrent();
      if (response.status !== 429) {
        assertResponsePrincipal(response, userId, onPrincipalMismatch);
        if (!response.ok) return json(response, lifetime, () => { throw new ApiError('protocol', response.status); }, () => errorBytes(response, lifetime));
        return response;
      }
      const observedAt = performance.now();
      // A present identity is always checked, including on an early busy response.
      if (response.headers.has('Daynight-User-ID')) assertResponsePrincipal(response, userId, onPrincipalMismatch);
      let failure: unknown;
      try { await json(response, lifetime, () => { throw new ApiError('protocol', response.status); }, () => errorBytes(response, lifetime)); }
      catch (error) { failure = error; }
      assertCurrent();
      if (!(failure instanceof ApiError && failure.kind === 'server' && failure.status === 429 && failure.code === 'resource_busy')) {
        assertResponsePrincipal(response, userId, onPrincipalMismatch);
        throw failure;
      }
      firstBusy ??= observedAt;
      const hint = retryAfter(response.headers.get('Retry-After'));
      const delay = Math.max(archiveRetryDelay(attempt, Math.random()), hint ?? 0);
      if (retries >= MAX_RETRIES || (hint !== null && hint > 12_000) || delay > BUDGET_MS - (performance.now() - firstBusy)) {
        console.warn('Session archive retry exhausted', { sessionId, phase, retries, requestId: failure.requestId, code: failure.code });
        throw failure;
      }
      retries += 1;
      attempt += 1;
      console.warn('Session archive retry', { sessionId, phase, retries, delayMs: Math.round(delay), requestId: failure.requestId, code: failure.code });
      await wait(delay, lifetime);
      assertCurrent();
      if (performance.now() - firstBusy >= BUDGET_MS) throw failure;
    }
  };
  return { get, assertCurrent };
}
