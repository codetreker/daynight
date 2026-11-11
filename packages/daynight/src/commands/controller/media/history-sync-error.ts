const maxDiagnosticBytes = 16 * 1024;
type HistoryOperation = "GET status" | "PUT chunk";
type DiagnosticIdentifiers = { code?: string; requestId?: string };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const readIdentifiers = async (response: Response, signal: AbortSignal): Promise<DiagnosticIdentifiers> => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancel: (() => void) | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (!response.body) return {};
    reader = response.body.getReader();
    const body = reader;
    let canceled = false;
    // Diagnostic cleanup cannot extend the failed request's deadline, including
    // when an underlying stream's cancellation promise never settles.
    cancel = () => { if (!canceled) { canceled = true; void body.cancel().catch(() => {}); } };
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => { cancel!(); reject(new Error("History diagnostic read aborted.")); };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    if (signal.aborted) onAbort!();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await Promise.race([body.read(), aborted]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxDiagnosticBytes) { cancel(); return {}; }
      if (next.value.byteLength !== 0) chunks.push(next.value);
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!record(value) || !record(value.error)) return {};
    const { code, requestId } = value.error;
    return {
      ...(typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? { code } : {}),
      ...(typeof requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(requestId) ? { requestId } : {}),
    };
  } catch {
    cancel?.();
    return {};
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    reader?.releaseLock();
  }
};

/** Retain the HTTP failure even when its optional diagnostic body is unusable. */
export const historySyncHttpError = async (response: Response, operation: HistoryOperation, signal: AbortSignal): Promise<Error & { status: number }> => {
  const { code, requestId } = await readIdentifiers(response, signal);
  const details = [String(response.status), ...(code === undefined ? [] : [`code=${code}`]), ...(requestId === undefined ? [] : [`requestId=${requestId}`])];
  return Object.assign(new Error(`Controller history synchronization ${operation} failed (${details.join("; ")}).`), { status: response.status });
};
