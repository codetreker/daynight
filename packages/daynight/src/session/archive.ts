import { parseSessionResource, parseTimelineEntry, type SessionFence, type SessionProvider, type SessionResource, type TimelineEntry } from "./protocol.js";

// Archives are inert display records, never native resume or command inputs.
export const SESSION_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
export const SESSION_ARCHIVE_RESOURCE_MAX_BYTES = 8 * 1024 * 1024;
export type SessionArchive = SessionFence & {
  readonly schemaVersion: 1;
  readonly controllerId: string;
  readonly controllerInstanceId: string;
  readonly provider: SessionProvider;
  readonly nativeSessionId: string | null;
  readonly entries: readonly TimelineEntry[];
  readonly resources: readonly { readonly resource: SessionResource; readonly data: string | null }[];
};
export type SessionArchiveStatus = {
  readonly state: "pending" | "ready" | "failed" | "unavailable";
  readonly sha256: string | null;
  readonly byteLength: string | null;
  readonly errorCode: string | null;
};

const invalid = (): never => { throw new Error("Invalid Daynight session archive."); };
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) return invalid();
  return data;
};
const uuid = (value: unknown): string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) ? value : invalid();
const sequence = (value: unknown): string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n ? value : invalid();
const hash = (value: unknown): string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : invalid();

export const parseSessionArchiveStatus = (value: unknown): SessionArchiveStatus => {
  const data = exact(value, ["state", "sha256", "byteLength", "errorCode"]);
  if (!["pending", "ready", "failed", "unavailable"].includes(String(data.state))) return invalid();
  if (data.state === "ready") {
    const byteLength = sequence(data.byteLength);
    if (BigInt(byteLength) > BigInt(SESSION_ARCHIVE_MAX_BYTES) || data.errorCode !== null) return invalid();
    return { state: "ready", sha256: hash(data.sha256), byteLength, errorCode: null };
  }
  if (data.sha256 !== null || data.byteLength !== null || (data.errorCode !== null && (typeof data.errorCode !== "string" || !/^[a-z_]{1,64}$/.test(data.errorCode)))) return invalid();
  if (data.state !== "failed" && data.errorCode !== null) return invalid();
  return { state: data.state as SessionArchiveStatus["state"], sha256: null, byteLength: null, errorCode: data.errorCode as string | null };
};

export const parseSessionArchive = (value: unknown): SessionArchive => {
  const test = !!value && typeof value === "object" && Object.hasOwn(value, "testExecutionId");
  const data = exact(value, ["schemaVersion", "sessionId", test ? "testExecutionId" : "claimId", "executionGeneration", "controllerId", "controllerInstanceId", "provider", "nativeSessionId", "entries", "resources"]);
  if (data.schemaVersion !== 1 || !["codex", "claude", "copilot"].includes(String(data.provider))) return invalid();
  if (data.nativeSessionId !== null && (typeof data.nativeSessionId !== "string" || !data.nativeSessionId.trim() || !data.nativeSessionId.isWellFormed() || /\p{Cc}/u.test(data.nativeSessionId) || new TextEncoder().encode(data.nativeSessionId).byteLength > 256)) return invalid();
  if (!Array.isArray(data.entries) || data.entries.length > 100_000 || !Array.isArray(data.resources) || data.resources.length > 1000) return invalid();
  const entries = data.entries.map(parseTimelineEntry), ids = new Set<string>();
  let previous = 0n;
  for (const entry of entries) {
    if (ids.has(entry.entryId) || BigInt(entry.entrySeq) <= previous) return invalid();
    ids.add(entry.entryId); previous = BigInt(entry.entrySeq);
  }
  const resourceIds = new Set<string>();
  const resources = data.resources.map(raw => {
    const item = exact(raw, ["resource", "data"]), resource = parseSessionResource(item.resource);
    if (resourceIds.has(resource.resourceId) || resource.status === "pending") return invalid();
    resourceIds.add(resource.resourceId);
    if (resource.status === "available") {
      if (typeof item.data !== "string" || item.data.length > Math.ceil(SESSION_ARCHIVE_RESOURCE_MAX_BYTES / 3) * 4 || item.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) return invalid();
      let decoded: string; try { decoded = atob(item.data); } catch { return invalid(); }
      if (btoa(decoded) !== item.data || decoded.length > SESSION_ARCHIVE_RESOURCE_MAX_BYTES || String(decoded.length) !== resource.byteLength || resource.sha256 === null) return invalid();
      hash(resource.sha256);
    } else if (item.data !== null) return invalid();
    return { resource, data: item.data as string | null };
  });
  for (const entry of entries) {
    const parts = entry.kind === "tool_call" ? entry.output : entry.kind === "user_message" || entry.kind === "assistant_message" ? entry.content : [];
    if (parts.some(part => part.type === "resource" && !resourceIds.has(part.resourceId))) return invalid();
  }
  const result: SessionArchive = {
    schemaVersion: 1, sessionId: uuid(data.sessionId), executionGeneration: sequence(data.executionGeneration),
    ...(test ? { testExecutionId: uuid(data.testExecutionId) } : { claimId: uuid(data.claimId) }),
    controllerId: uuid(data.controllerId), controllerInstanceId: uuid(data.controllerInstanceId),
    provider: data.provider as SessionProvider, nativeSessionId: data.nativeSessionId as string | null, entries, resources,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > SESSION_ARCHIVE_MAX_BYTES) return invalid();
  return result;
};

/** Structural parsing is synchronous; binary integrity is checked before use. */
export const verifySessionArchiveResources = async (archive: SessionArchive): Promise<void> => {
  for (const { resource, data } of archive.resources) {
    if (data === null) continue;
    const bytes = Uint8Array.from(atob(data), value => value.charCodeAt(0));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
    if (digest !== resource.sha256) return invalid();
  }
};
