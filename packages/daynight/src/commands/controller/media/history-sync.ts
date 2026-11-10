import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parseSessionArchiveFileReceipt, type SessionArchiveFileReceipt } from "../../../session/archive.js";
import type { ControllerFence } from "../../../session/protocol.js";
import type { ControllerLaunchTicket } from "../launch-ticket.js";
import type { ControllerLifecycleStore } from "../lifecycle-store.js";
import { readControllerGrant } from "../relay.js";

/** A frozen body and sync ID survive unknown HTTP results and reconnects. */
export const syncControllerImageHistory = async (options: {
  ticket: ControllerLaunchTicket; journal: ControllerLifecycleStore; fence: ControllerFence;
  currentFence(): ControllerFence | null; signal?: AbortSignal; request?: typeof fetch;
}): Promise<void> => {
  const { ticket, journal, fence } = options;
  const intent = journal.prepareImageHistorySync(); if (!intent) return;
  const root = ticket.testExecutionId !== undefined ? `/api/v1/test-sessions/${ticket.sessionId}` : `/api/v1/projects/${ticket.projectId}/tasks/${ticket.taskId}/sessions/${ticket.sessionId}`;
  const url = `${ticket.serverOrigin}${root}/image-history-ledger/${intent.syncId}`, request = options.request ?? fetch;
  const call = async (method: string, suffix: string, bytes?: Uint8Array): Promise<unknown> => {
    options.signal?.throwIfAborted();
    if (JSON.stringify(options.currentFence()) !== JSON.stringify(fence)) throw new Error("Controller history connection changed before synchronization.");
    const grant = await readControllerGrant(ticket);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    const response = await request(`${url}${suffix}`, { method, redirect: "error", headers: { Authorization: `Bearer ${grant.token}`, "Daynight-Controller-Fence": JSON.stringify(fence), ...(bytes === undefined ? {} : { "Content-Type": "application/octet-stream", "Daynight-File-Byte-Length": intent.byteLength, "Daynight-File-SHA256": intent.sha256, "Daynight-Chunk-SHA256": createHash("sha256").update(bytes).digest("hex") }) }, ...(bytes === undefined ? {} : { body: Uint8Array.from(bytes) }), signal });
    if (!response.ok) throw Object.assign(new Error(`Controller history synchronization failed (${response.status}).`), { status: response.status });
    return response.json();
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
      receipt = parse(await call("PUT", `?offset=${offset}`, buffer.subarray(0, result.bytesRead)));
      if (Number(receipt.acceptedOffset) < accepted || receipt.state === "receiving" && Number(receipt.acceptedOffset) === accepted && accepted < stat.size) throw new Error("Controller history did not confirm the original chunk prefix.");
    }
  } finally { await file.close(); }
  journal.finishImageHistorySync(intent.syncId, receipt.state === "complete");
  if (receipt.state !== "complete") throw new Error("The original controller history synchronization failed.");
};
