import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { sessionBinding } from "../../session/protocol.js";
import { parseSessionArchive, parseSessionArchiveStatus, verifySessionArchiveResources, type SessionArchiveStatus } from "../../session/archive.js";
import type { ControllerLaunchTicket } from "./launch-ticket.js";
import { readControllerSnapshot } from "./lifecycle-store.js";
import { migratePendingContent, reconcilePendingContent, openPendingContent, writeDurableJson } from "./pending-content.js";

export const uploadStoppedControllerArchive = async (options: { journalPath: string; ticket: ControllerLaunchTicket; serverToken: string; request?: typeof fetch; signal?: AbortSignal }): Promise<SessionArchiveStatus> => {
  const { ticket, journalPath } = options;
  const fence = { sessionId: ticket.sessionId, ...sessionBinding(ticket), executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId };
  const root = ticket.testExecutionId !== undefined ? `/api/v1/test-sessions/${ticket.sessionId}` : `/api/v1/projects/${ticket.projectId}/tasks/${ticket.taskId}/sessions/${ticket.sessionId}`;
  const request = options.request ?? fetch;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const call = async (method: string, body?: string): Promise<SessionArchiveStatus> => {
    const response = await request(`${ticket.serverOrigin}${root}/archive`, { method, redirect: "error", headers: { Authorization: `Bearer ${options.serverToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body }), signal });
    if (!response.ok) throw new Error(`Session archive request failed (${response.status}).`);
    return parseSessionArchiveStatus((await response.json() as { archive: unknown }).archive);
  };
  const observed = readControllerSnapshot(journalPath);
  if (!observed || !observed.nativeStopped || observed.lifecycle !== "stopped" || observed.sessionId !== ticket.sessionId || observed.executionGeneration !== ticket.executionGeneration || observed.controllerInstanceId !== ticket.controllerInstanceId || observed.executionId !== ticket.executionId || observed.claimId !== ticket.claimId || observed.testExecutionId !== ticket.testExecutionId) throw new Error("Session archive requires the original stopped controller generation.");
  const receiptPath = `${journalPath}.archive-receipt-${ticket.executionGeneration}.json`;
  let receipt: SessionArchiveStatus | null = null;
  if (existsSync(receiptPath)) {
    receipt = parseSessionArchiveStatus(JSON.parse(readFileSync(receiptPath, "utf8")));
    if (receipt.state !== "ready") throw new Error("Invalid local archive receipt.");
    const current = await call("GET");
    if (current.state === "ready") {
      if (current.sha256 !== receipt.sha256 || current.byteLength !== receipt.byteLength) throw new Error("Server archive differs from the confirmed receipt.");
      return current;
    }
  }
  let body: string;
  try {
    const db = new Database(journalPath);
    try {
      const version = Number(db.pragma("user_version", { simple: true }));
      if (version < 2 || version > 6) throw new Error("Unsupported controller archive journal.");
      if (version >= 6 && !existsSync(`${journalPath}.pending-content/manifest.json`)) throw new Error("Pending archive source is missing.");
      const content = openPendingContent(journalPath, ticket.sessionId);
      migratePendingContent(db, content);
      reconcilePendingContent(db, content);
      const gap = db.prepare("SELECT projection_gap,archive_incomplete FROM execution WHERE id=1").get() as { projection_gap: string | null; archive_incomplete: number };
      if (gap.archive_incomplete !== 0 || gap.projection_gap !== null && gap.projection_gap !== "Recovered pending timeline requires full relay resynchronization.") throw new Error("Pending archive has an unresolved projection gap.");
      const archive = parseSessionArchive({ schemaVersion: 1, ...fence, provider: ticket.provider, nativeSessionId: observed.nativeSessionId, entries: [...content.entries.values()].sort((a,b) => BigInt(a.entrySeq) < BigInt(b.entrySeq) ? -1 : 1), resources: [...content.resources.values()].sort((a,b) => a.resource.resourceId.localeCompare(b.resource.resourceId)) });
      await verifySessionArchiveResources(archive);
      body = JSON.stringify(archive);
    } finally { db.close(); }
  } catch (error) {
    await call("POST", JSON.stringify({ ...fence, state: "failed", errorCode: "archive_incomplete" })).catch(() => {});
    throw error;
  }
  const sha256 = createHash("sha256").update(body).digest("hex"), byteLength = String(Buffer.byteLength(body));
  const matches = (status: SessionArchiveStatus) => status.state === "ready" && status.sha256 === sha256 && status.byteLength === byteLength;
  if (receipt && !matches(receipt)) throw new Error("Archive receipt does not match the original content.");
  try {
    const current = await call("GET");
    if (current.state === "ready") {
      if (!matches(current)) throw new Error("Server archive differs from the stopped execution.");
      writeDurableJson(receiptPath, current); return current;
    }
    await call("POST", JSON.stringify({ ...fence, state: "pending", errorCode: null }));
    const uploaded = await call("PUT", body);
    if (!matches(uploaded)) throw new Error("Session archive upload was not confirmed with matching integrity.");
    writeDurableJson(receiptPath, uploaded); return uploaded;
  } catch (error) {
    await call("POST", JSON.stringify({ ...fence, state: "failed", errorCode: "upload_failed" })).catch(() => {});
    throw error;
  }
};
