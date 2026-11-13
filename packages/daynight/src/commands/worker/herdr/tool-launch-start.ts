import { randomUUID } from "node:crypto";
import path from "node:path";
import { canonicalId } from "../../../api/parse.js";
import { replaceFileAtomically } from "../../../platform/files.js";
import { syncDurableDirectory } from "../../../platform/durable-directory.js";
import { canonicalResourceOwner, sameResourceOwner } from "../resource-owner.js";
import type { HerdrExecutionOwner, HerdrTaskBinding } from "./agents.js";
import { launchArgvDigest, mappingFiles, optionalOwnedJson, publishOwnedJson } from "./tool-launch-protocol.js";

export const nativeStartRejectionCodes: ReadonlySet<string> = new Set(["invalid_agent_name", "unsupported_agent_kind", "invalid_agent_argument", "invalid_agent_timeout", "agent_pane_not_found", "agent_pane_busy", "agent_pane_unavailable", "agent_name_taken"]);
type Identity = { nonce: string; selectionKey: string; owner: HerdrExecutionOwner };
export type ToolStartRequest = Identity & { requestId: string; binding: HerdrTaskBinding; logicalArgvDigest: string; attempt: number; state: "reserved" | "rejected" | "not_submitted"; rejectionCode: string | null };

export const parseToolStartRequest = (value: unknown, identity: Identity): ToolStartRequest => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("The original native launch request fence is invalid.");
  const row = value as ToolStartRequest;
  if (Object.keys(row).sort().join() !== "attempt,binding,logicalArgvDigest,nonce,owner,rejectionCode,requestId,selectionKey,state" || row.nonce !== identity.nonce || row.selectionKey !== identity.selectionKey || (!sameResourceOwner(row.owner, identity.owner) || JSON.stringify(row.owner) !== JSON.stringify(canonicalResourceOwner(identity.owner))) || canonicalId(row.requestId) !== row.requestId || !/^[a-f0-9]{64}$/.test(row.logicalArgvDigest) || !Number.isSafeInteger(row.attempt) || row.attempt < 0 || row.attempt > 1000 || row.state !== "reserved" && row.state !== "rejected" && row.state !== "not_submitted" || row.state !== "rejected" && row.rejectionCode !== null || row.state === "rejected" && (typeof row.rejectionCode !== "string" || !nativeStartRejectionCodes.has(row.rejectionCode))) throw new Error("The original native launch request fence has conflicting identity or outcome.");
  if (row.binding === null || typeof row.binding !== "object" || Object.keys(row.binding).sort().join() !== "paneId,session,terminalId,workspaceId" || Object.values(row.binding).some(value => typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\0\r\n]/.test(value))) throw new Error("The original native launch request has an invalid Herdr binding.");
  return structuredClone(row);
};

export const readToolStartRequest = async (manifestPath: string, identity: Identity): Promise<ToolStartRequest | null> => {
  const value = await optionalOwnedJson(mappingFiles(manifestPath).nativeStart);
  return value === null ? null : parseToolStartRequest(value, identity);
};

/** A lost RPC retains its fence; only a definite non-launch may reuse the exact request. */
export const reserveToolStartRequest = async (manifestPath: string, identity: Identity, binding: HerdrTaskBinding, agent: string, args: readonly string[]): Promise<ToolStartRequest> => {
  const row: ToolStartRequest = { nonce: identity.nonce, selectionKey: identity.selectionKey, owner: canonicalResourceOwner(identity.owner), requestId: randomUUID(), binding: { ...binding }, logicalArgvDigest: launchArgvDigest(agent, args), attempt: 0, state: "reserved", rejectionCode: null };
  parseToolStartRequest(row, identity);
  const files = mappingFiles(manifestPath);
  if (await optionalOwnedJson(files.intent) !== null || await optionalOwnedJson(files.receipt) !== null) throw new Error("The original helper launch already exists; another native start RPC is prohibited.");
  const previous = await readToolStartRequest(manifestPath, identity);
  if (previous !== null) {
    if (JSON.stringify(previous.binding) !== JSON.stringify(row.binding) || previous.logicalArgvDigest !== row.logicalArgvDigest) throw new Error("The original native launch request has different binding or arguments.");
    return await advanceToolStartRequest(manifestPath, previous);
  }
  await publishOwnedJson(files.nativeStart, row);
  return row;
};

/** Only the reserving caller may settle an attempt; definite non-launches can be readmitted. */
export const advanceToolStartRequest = async (manifestPath: string, previous: ToolStartRequest, rejectionCode?: string): Promise<ToolStartRequest> => {
  const current = await readToolStartRequest(manifestPath, previous);
  if (JSON.stringify(current) !== JSON.stringify(previous) || rejectionCode === undefined && previous.state !== "rejected" && previous.state !== "not_submitted" || rejectionCode !== undefined && previous.state !== "reserved") throw new Error("The original native launch request changed before its durable outcome could be recorded.");
  const next: ToolStartRequest = rejectionCode === undefined ? { ...previous, attempt: previous.attempt + 1, state: "reserved", rejectionCode: null } : { ...previous, state: "rejected", rejectionCode };
  parseToolStartRequest(next, previous);
  const file = mappingFiles(manifestPath).nativeStart;
  // An immutable attempt fence prevents two callers from readmitting the same
  // settled request. A crash before publication remains unknown, never replayable.
  if (rejectionCode === undefined) await publishOwnedJson(path.join(path.dirname(file), `native-start-${next.requestId}-${next.attempt}.json`), next);
  await replaceFileAtomically(file, JSON.stringify(next), 0o600); syncDurableDirectory(path.dirname(file));
  return next;
};

/** Called only before RPC dispatch by the caller that holds the live reservation. */
export const deferToolStartRequest = async (manifestPath: string, previous: ToolStartRequest): Promise<ToolStartRequest> => {
  const current = await readToolStartRequest(manifestPath, previous);
  if (previous.state !== "reserved" || JSON.stringify(current) !== JSON.stringify(previous)) throw new Error("The original unsubmitted launch request changed before admission closed.");
  const next: ToolStartRequest = { ...previous, state: "not_submitted", rejectionCode: null };
  const file = mappingFiles(manifestPath).nativeStart;
  await replaceFileAtomically(file, JSON.stringify(next), 0o600); syncDurableDirectory(path.dirname(file));
  return next;
};
