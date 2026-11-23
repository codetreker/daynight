import { TASK_BODY_HISTORY_VERSION_HEADER } from "../../session/archive.js";
import { SESSION_PROTOCOL } from "../../session/protocol.js";
import { ArchiveProtocolError } from "./archive-error.js";
import { ARCHIVE_MAX_RETRIES, ARCHIVE_REQUEST_TIMEOUT_MS, ARCHIVE_STREAM_TIMEOUT_MS, archiveRetryDelay, archiveRetryRuntime, readArchiveRequestError, type ArchiveRetryEvent, type ArchiveRetryRuntime } from "./archive-retry.js";

/** Replays only requests admitted by the uploader's existing intent/receipt contract. */
export const createArchiveRequest = (options: {
  request: typeof fetch; url: string; serverToken: string; bodyOnly(): boolean;
  signal: AbortSignal; parentSignal?: AbortSignal; deadline: number; sessionId: string;
  retryRuntime?: ArchiveRetryRuntime; onRetry?(event: ArchiveRetryEvent): void;
}) => {
  const runtime = options.retryRuntime ?? archiveRetryRuntime;
  return async (method: string, suffix: string, replayable: boolean, body?: string | Uint8Array | ReadableStream<Uint8Array>, extra: Record<string, string> = {}, sourceSignal?: AbortSignal, config?: { streaming?: boolean; onResponse?(response: Response): void }): Promise<unknown> => {
    const operationSignal = sourceSignal ? AbortSignal.any([options.signal, sourceSignal]) : options.signal;
    for (let retries = 0; ; retries++) {
      operationSignal.throwIfAborted();
      const signal = AbortSignal.any([operationSignal, AbortSignal.timeout(config?.streaming ? ARCHIVE_STREAM_TIMEOUT_MS : ARCHIVE_REQUEST_TIMEOUT_MS)]);
      const response = await options.request(`${options.url}${suffix}`, {
        method, redirect: "error",
        headers: { Authorization: `Bearer ${options.serverToken}`, "Daynight-Session-Protocol": SESSION_PROTOCOL, ...(options.bodyOnly() ? { [TASK_BODY_HISTORY_VERSION_HEADER]: "1" } : {}), ...(body === undefined ? {} : { "Content-Type": typeof body === "string" ? "application/json" : "application/octet-stream" }), ...extra },
        ...(body === undefined ? {} : { body: typeof body === "string" || body instanceof ReadableStream ? body : Uint8Array.from(body) }), ...(body instanceof ReadableStream ? { duplex: "half" } : {}), signal,
      } as RequestInit);
      signal.throwIfAborted();
      config?.onResponse?.(response);
      if (response.ok) {
        if (options.bodyOnly() && response.headers.get(TASK_BODY_HISTORY_VERSION_HEADER) !== "1") {
          await response.body?.cancel();
          throw new ArchiveProtocolError("upgrade_required: The service does not support Task body archives.");
        }
        return response.json();
      }
      // Early capacity rejection on an older service can precede the version header.
      const error = await readArchiveRequestError(response, signal);
      if (!error.busy && options.bodyOnly() && response.headers.get(TASK_BODY_HISTORY_VERSION_HEADER) !== "1") throw new Error("upgrade_required: The service does not support Task body archives.");
      if (!error.busy || !replayable) throw error;
      const responseRequestId = response.headers.get("X-Request-ID");
      const requestId = responseRequestId !== null && /^[A-Za-z0-9._:-]{1,128}$/.test(responseRequestId) ? responseRequestId : null;
      const now = runtime.now();
      const delayMs = retries >= ARCHIVE_MAX_RETRIES ? null : archiveRetryDelay({ retry: retries + 1, retryAfter: response.headers.get("Retry-After"), now, random: () => runtime.random(), remainingMs: options.deadline - now });
      const exhausted = (): void => options.onRetry?.({ phase: "exhausted", retry: retries, delayMs: null, classification: "resource_busy", requestId, sessionId: options.sessionId });
      if (delayMs === null) exhausted();
      else options.onRetry?.({ phase: "waiting", retry: retries + 1, delayMs, classification: "resource_busy", requestId, sessionId: options.sessionId });
      if (delayMs === null) throw error;
      try {
        await runtime.wait(delayMs, operationSignal);
        operationSignal.throwIfAborted();
        if (runtime.now() >= options.deadline) throw error;
      } catch (cause) {
        if (cause === error || options.signal.aborted && !options.parentSignal?.aborted) { exhausted(); throw error; }
        throw cause;
      }
    }
  };
};
