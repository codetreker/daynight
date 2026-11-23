import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { TASK_BODY_HISTORY_VERSION_HEADER, parseSessionArchiveFileReceipt, type SessionArchiveFileReceipt } from "../../../session/archive.js";
import type { ControllerFence } from "../../../session/protocol.js";
import type { ControllerLaunchTicket } from "../launch-ticket.js";
import type { ControllerLifecycleStore } from "../lifecycle-store.js";
import { readControllerGrant } from "../relay.js";
import type { ImageError } from "../../../session/image-values.js";
import { ImageCaptureNotDispatchedError } from "./capture-error.js";
import { ARCHIVE_REQUEST_TIMEOUT_MS, archiveRetryDelay, archiveRetryRuntime, readArchiveRequestError, type ArchiveRetryEvent, type ArchiveRetryRuntime } from "../archive-retry.js";
import type { ArchiveRequestError } from "../archive-error.js";

export const createImageHistoryRetryBudget = (): { retries: number; deadline: number | null; lastError?: ArchiveRequestError } => ({ retries: 0, deadline: null });

export class ImageHistorySyncFailedError extends Error {
  constructor(readonly imageError: ImageError) {
    super(imageError.message);
    this.name = "ImageHistorySyncFailedError";
  }
}

/** A confirmed history refusal remains visible until a later checkpoint succeeds. */
export const assertImageHistoryAvailable = (journal: ControllerLifecycleStore): void => {
  const failure = journal.getImageHistorySyncFailure();
  if (failure) throw new ImageHistorySyncFailedError(failure);
};

/** A frozen body and sync ID survive unknown HTTP results and reconnects. */
export const syncControllerImageHistory = async (options: {
  ticket: ControllerLaunchTicket; journal: ControllerLifecycleStore; fence: ControllerFence;
  currentFence(): ControllerFence | null; signal?: AbortSignal; request?: typeof fetch;
  requiredSourceThrough?: string;
  retryBudget?: ReturnType<typeof createImageHistoryRetryBudget>;
  retryRuntime?: ArchiveRetryRuntime; onRetry?(event: ArchiveRetryEvent): void;
}): Promise<void> => {
  const { ticket, journal, fence } = options;
  const budget = options.retryBudget ?? createImageHistoryRetryBudget(), runtime = options.retryRuntime ?? archiveRetryRuntime;
  const checkConnection = () => {
    options.signal?.throwIfAborted();
    if (JSON.stringify(options.currentFence()) !== JSON.stringify(fence)) throw new Error("Controller history connection changed before synchronization.");
  };
  const bodyOnly = journal.getHistoryContentPolicy() === "task_body";
  const intent = journal.prepareImageHistorySync();
  if (!intent) {
    if (options.requiredSourceThrough !== undefined && !journal.hasImageHistoryCheckpoint(options.requiredSourceThrough)) throw new ImageCaptureNotDispatchedError("Image capture is waiting for its complete acknowledged history checkpoint.");
    return;
  }
  const root = ticket.testExecutionId !== undefined ? `/api/v1/test-sessions/${ticket.sessionId}` : `/api/v1/projects/${ticket.projectId}/tasks/${ticket.taskId}/sessions/${ticket.sessionId}`;
  const url = `${ticket.serverOrigin}${root}/image-history-ledger/${intent.syncId}`, request = options.request ?? fetch;
  const call = async (method: string, suffix: string, bytes?: Uint8Array, reconcile = false): Promise<unknown> => {
    const check = (includeDeadline = true) => {
      checkConnection();
      if (includeDeadline && !reconcile && budget.deadline !== null && runtime.now() >= budget.deadline) throw budget.lastError;
    };
    for (let retries = 0; ; retries++) {
      check();
      const grant = await readControllerGrant(ticket);
      check();
      const roundTimeout = reconcile || budget.deadline === null ? undefined : AbortSignal.timeout(Math.max(1, budget.deadline - runtime.now()));
      const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(ARCHIVE_REQUEST_TIMEOUT_MS), ...(roundTimeout ? [roundTimeout] : [])]);
      let response: Response;
      try { response = await request(`${url}${suffix}`, { method, redirect: "error", headers: { Authorization: `Bearer ${grant.token}`, "Daynight-Controller-Fence": JSON.stringify(fence), ...(bodyOnly ? { [TASK_BODY_HISTORY_VERSION_HEADER]: "1" } : {}), ...(bytes === undefined ? {} : { "Content-Type": "application/octet-stream", "Daynight-File-Byte-Length": intent.byteLength, "Daynight-File-SHA256": intent.sha256, "Daynight-Chunk-SHA256": createHash("sha256").update(bytes).digest("hex") }) }, ...(bytes === undefined ? {} : { body: Uint8Array.from(bytes) }), signal }); }
      catch (error) { options.signal?.throwIfAborted(); if (roundTimeout?.aborted && method === "GET") throw budget.lastError; throw error; }
      check(method !== "PUT");
      signal.throwIfAborted();
      if (response.ok) {
        if (bodyOnly && response.headers.get(TASK_BODY_HISTORY_VERSION_HEADER) !== "1") { await response.body?.cancel(); throw new Error("upgrade_required: The service does not support Task body history synchronization."); }
        const value: unknown = await response.json();
        check(method !== "PUT");
        signal.throwIfAborted();
        return value;
      }
      const error = await readArchiveRequestError(response, signal);
      if (!error.busy && bodyOnly && response.headers.get(TASK_BODY_HISTORY_VERSION_HEADER) !== "1") throw new Error("upgrade_required: The service does not support Task body history synchronization.");
      if (!error.busy) throw error;
      if (reconcile && budget.deadline !== null && runtime.now() >= budget.deadline) throw error;
      const now = runtime.now();
      budget.deadline ??= now + 30_000;
      budget.lastError = error;
      const delayMs = budget.retries >= 4 ? null : archiveRetryDelay({ retry: retries + 1, retryAfter: response.headers.get("Retry-After"), now, random: () => runtime.random(), remainingMs: budget.deadline - now });
      const rawId = response.headers.get("X-Request-ID"), requestId = rawId !== null && /^[A-Za-z0-9._:-]{1,128}$/.test(rawId) ? rawId : null;
      options.onRetry?.({ phase: delayMs === null ? "exhausted" : "waiting", retry: delayMs === null ? budget.retries : budget.retries + 1, delayMs, classification: "resource_busy", requestId, sessionId: ticket.sessionId });
      if (delayMs === null) throw error;
      check();
      budget.retries++;
      await runtime.wait(delayMs, options.signal ?? new AbortController().signal);
      check(false);
      if (runtime.now() >= budget.deadline) { options.onRetry?.({ phase: "exhausted", retry: budget.retries, delayMs: null, classification: "resource_busy", requestId, sessionId: ticket.sessionId }); throw error; }
    }
  };
  const parse = (value: unknown): SessionArchiveFileReceipt => {
    if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "acceptedOffset,byteLength,error,sha256,state,syncId,timelineRevision") throw new Error("Invalid image history synchronization receipt.");
    const { syncId, timelineRevision, ...rest } = value as Record<string, unknown>;
    if (rest.state === "complete" ? typeof timelineRevision !== "string" || !/^[1-9][0-9]{0,18}$/.test(timelineRevision) : timelineRevision !== null) throw new Error("Invalid image history synchronization checkpoint.");
    const receipt = parseSessionArchiveFileReceipt({ fileId: syncId, ...rest });
    if (receipt.fileId !== intent.syncId || receipt.byteLength !== intent.byteLength || receipt.sha256 !== intent.sha256) throw new Error("Image history receipt differs from its original synchronization intent.");
    return receipt;
  };
  let receipt: SessionArchiveFileReceipt | null = null;
  try { receipt = parse(await call("GET", "/status")); }
  catch (error) { if (!(error && typeof error === "object" && "status" in error && error.status === 404)) throw error; }
  if (receipt?.state !== "complete" && receipt?.state !== "failed") {
    const file = await open(intent.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat(); if (!stat.isFile() || String(stat.size) !== intent.byteLength || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Frozen controller history is not a private complete file.");
      const hash = createHash("sha256"), buffer = Buffer.alloc(1_048_576); let position = 0;
      while (position < stat.size) { const result = await file.read(buffer, 0, Math.min(buffer.length, stat.size - position), position); if (!result.bytesRead) throw new Error("Frozen controller history is incomplete."); hash.update(buffer.subarray(0, result.bytesRead)); position += result.bytesRead; }
      if (hash.digest("hex") !== intent.sha256) throw new Error("Frozen controller history integrity differs.");
      const unchanged = async () => { const current = await file.stat(); if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) throw new Error("Frozen controller history changed during synchronization."); };
      while (receipt?.state !== "complete" && receipt?.state !== "failed") {
        await unchanged();
        const accepted = Number(receipt?.acceptedOffset ?? "0"), offset = accepted === stat.size ? Math.floor((accepted - 1) / buffer.length) * buffer.length : accepted;
        const result = await file.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
        if (!result.bytesRead) throw new Error("Frozen controller history is incomplete.");
        await unchanged();
        try {
          receipt = parse(await call("PUT", `?offset=${offset}`, buffer.subarray(0, result.bytesRead)));
        } catch (original) {
          // A non-success response can still follow a durable failed or complete
          // write. Observe only this frozen identity before classifying it.
          options.signal?.throwIfAborted();
          let observed: SessionArchiveFileReceipt;
          try { observed = parse(await call("GET", "/status", undefined, true)); }
          catch (observation) { throw new AggregateError([original, observation], "Controller history write and original status observation failed.", { cause: original }); }
          if (observed.state !== "complete" && observed.state !== "failed") throw original;
          receipt = observed;
        }
        if (Number(receipt.acceptedOffset) < accepted || receipt.state === "receiving" && Number(receipt.acceptedOffset) === accepted && accepted < stat.size) throw new Error("Controller history did not confirm the original chunk prefix.");
      }
    } finally { await file.close(); }
  }
  if (!receipt) throw new Error("Controller history did not reach a terminal receipt.");
  checkConnection();
  const failure = receipt.state === "failed" ? receipt.error ?? { code: "history_unavailable", message: "The original controller history synchronization failed." } : undefined;
  journal.finishImageHistorySync(intent.syncId, receipt.state === "complete", failure);
  if (failure) throw new ImageHistorySyncFailedError(failure);
  // An older frozen upload must finish under its original identity before the
  // capture can establish the checkpoint containing its newly published slot.
  if (options.requiredSourceThrough !== undefined && !journal.hasImageHistoryCheckpoint(options.requiredSourceThrough)) await syncControllerImageHistory({ ...options, retryBudget: budget });
};
