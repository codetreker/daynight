import { parseSessionResource, parseTimelineEntry, sessionFence, type SessionFence, type SessionProvider, type SessionResource, type TimelineEntry } from "./protocol.js";
import { decodeStrictSessionJson } from "./v2/values.js";
import { parseImageError, verifyTimelineImageMetadata, type ImageError } from "./image-values.js";

// Archives are inert display records, never native resume or command inputs.
export const SESSION_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
export const SESSION_ARCHIVE_TIMELINE_MAX_BYTES = 128 * 1024 * 1024;
export const SESSION_ARCHIVE_HISTORY_MAX_BYTES = SESSION_ARCHIVE_TIMELINE_MAX_BYTES + 16 * 1024;
export const SESSION_ARCHIVE_RESOURCE_MAX_BYTES = 8 * 1024 * 1024;
export const SESSION_ARCHIVE_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
export const SESSION_ARCHIVE_BLOB_MAX_BYTES = 10 * 1024 * 1024;
export type SessionArchiveFileReference = { readonly fileId: string; readonly sha256: string; readonly byteLength: string };
export type SessionArchiveResourceReference = { readonly resource: SessionResource; readonly blobId: string | null };
export type SessionArchiveManifest = {
  readonly schemaVersion: 3; readonly contentKind: "native_timeline"; readonly recordId: string; readonly fence: SessionFence;
  readonly provider: SessionProvider; readonly nativeSessionId: string | null; readonly controllerId: string; readonly controllerInstanceId: string;
  readonly timeline: SessionArchiveFileReference; readonly resources: readonly SessionArchiveResourceReference[]; readonly completeness: "complete" | "partial";
};
export type SessionArchiveTimeline = { readonly entries: readonly TimelineEntry[] };
export type SessionArchivePreparation = { recordId: string; phase: "settling" | "sealed" | "failed"; resources: readonly SessionArchiveResourceReference[]; timelineRevision: string | null; error: ImageError | null; historyEpoch: string; sourceThrough: string };
export type SessionArchiveFileReceipt = SessionArchiveFileReference & { state: "receiving" | "complete" | "failed"; acceptedOffset: string; error: ImageError | null };
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
  readonly schemaVersion?: 3;
  readonly completeness?: "complete" | "partial" | null;
  readonly migration?: { readonly migrationId: string; readonly sourceSha256: string; readonly sourceByteLength: string };
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
const zeroSequence = (value: unknown): string => value === "0" ? "0" : sequence(value);

export const parseSessionArchivePreparation = (value: unknown): SessionArchivePreparation => {
  const data = exact(value, ["recordId", "phase", "resources", "timelineRevision", "error", "historyEpoch", "sourceThrough"]);
  if (!["settling", "sealed", "failed"].includes(String(data.phase)) || !Array.isArray(data.resources) || data.resources.length > 1000 || typeof data.historyEpoch !== "string" || !data.historyEpoch.trim() || !data.historyEpoch.isWellFormed() || data.historyEpoch.includes("\0") || new TextEncoder().encode(data.historyEpoch).length > 256) return invalid();
  const ids = new Set<string>(); const resources = data.resources.map(raw => { const item = exact(raw, ["resource", "blobId"]), resource = parseSessionResource(item.resource), blobId = item.blobId === null ? null : uuid(item.blobId); if (ids.has(resource.resourceId) || resource.status === "pending" || (resource.status === "available") !== (blobId !== null)) return invalid(); ids.add(resource.resourceId); return { resource, blobId }; });
  if (data.phase === "sealed" ? data.timelineRevision === null || data.error !== null : resources.length !== 0 || data.timelineRevision !== null || (data.phase === "failed") !== (data.error !== null)) return invalid();
  return { recordId: uuid(data.recordId), phase: data.phase as SessionArchivePreparation["phase"], resources, timelineRevision: data.timelineRevision === null ? null : sequence(data.timelineRevision), error: data.error === null ? null : parseImageError(data.error), historyEpoch: data.historyEpoch, sourceThrough: zeroSequence(data.sourceThrough) };
};
export const parseSessionArchiveFileReceipt = (value: unknown): SessionArchiveFileReceipt => {
  const data = exact(value, ["fileId", "state", "acceptedOffset", "byteLength", "sha256", "error"]), byteLength = zeroSequence(data.byteLength), acceptedOffset = zeroSequence(data.acceptedOffset);
  if (byteLength === "0" && data.sha256 !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" || !["receiving", "complete", "failed"].includes(String(data.state)) || BigInt(byteLength) > BigInt(SESSION_ARCHIVE_HISTORY_MAX_BYTES) || BigInt(acceptedOffset) > BigInt(byteLength) || data.state === "complete" && acceptedOffset !== byteLength || (data.state === "failed") !== (data.error !== null)) return invalid();
  return { fileId: uuid(data.fileId), state: data.state as SessionArchiveFileReceipt["state"], acceptedOffset, byteLength, sha256: hash(data.sha256), error: data.error === null ? null : parseImageError(data.error) };
};

export const parseSessionArchiveStatus = (value: unknown): SessionArchiveStatus => {
  const modern = !!value && typeof value === "object" && Object.hasOwn(value, "schemaVersion");
  const migrated = modern && Object.hasOwn(value as object, "migration");
  const data = exact(value, ["state", "sha256", "byteLength", "errorCode", ...(modern ? ["schemaVersion", "completeness"] : []), ...(migrated ? ["migration"] : [])]);
  if (modern && (data.schemaVersion !== 3 || (data.state === "ready" ? !["complete", "partial"].includes(String(data.completeness)) : data.completeness !== null))) return invalid();
  const extra = modern ? { schemaVersion: 3 as const, completeness: data.completeness as "complete" | "partial" | null } : {};
  if (!["pending", "ready", "failed", "unavailable"].includes(String(data.state))) return invalid();
  if (data.state === "ready") {
    const byteLength = sequence(data.byteLength);
    if (BigInt(byteLength) > BigInt(modern ? SESSION_ARCHIVE_MANIFEST_MAX_BYTES : SESSION_ARCHIVE_MAX_BYTES) || data.errorCode !== null) return invalid();
    let migration: SessionArchiveStatus["migration"];
    if (migrated) {
      const source = exact(data.migration, ["migrationId", "sourceSha256", "sourceByteLength"]);
      const sourceByteLength = sequence(source.sourceByteLength);
      if (BigInt(sourceByteLength) > BigInt(SESSION_ARCHIVE_MAX_BYTES)) return invalid();
      migration = { migrationId: uuid(source.migrationId), sourceSha256: hash(source.sourceSha256), sourceByteLength };
    }
    return { state: "ready", sha256: hash(data.sha256), byteLength, errorCode: null, ...extra, ...(migration ? { migration } : {}) };
  }
  if (migrated) return invalid();
  if (data.sha256 !== null || data.byteLength !== null || (data.errorCode !== null && (typeof data.errorCode !== "string" || !/^[a-z_]{1,64}$/.test(data.errorCode)))) return invalid();
  if (data.state !== "failed" && data.errorCode !== null) return invalid();
  return { state: data.state as SessionArchiveStatus["state"], sha256: null, byteLength: null, errorCode: data.errorCode as string | null, ...extra };
};

export const parseSessionArchiveManifest = (value: unknown): SessionArchiveManifest => {
  const data = exact(value, ["schemaVersion", "contentKind", "recordId", "fence", "provider", "nativeSessionId", "controllerId", "controllerInstanceId", "timeline", "resources", "completeness"]);
  if (data.schemaVersion !== 3 || data.contentKind !== "native_timeline" || !["codex", "claude", "copilot"].includes(String(data.provider)) || !["complete", "partial"].includes(String(data.completeness))) return invalid();
  const binding = sessionFence(data.fence as SessionFence);
  exact(data.fence, ["sessionId", binding.claimId !== undefined ? "claimId" : "testExecutionId", "executionGeneration"]);
  if (uuid(data.recordId) !== binding.sessionId) return invalid();
  if (data.nativeSessionId !== null && (typeof data.nativeSessionId !== "string" || !data.nativeSessionId.trim() || !data.nativeSessionId.isWellFormed() || /\p{Cc}/u.test(data.nativeSessionId) || new TextEncoder().encode(data.nativeSessionId).length > 256)) return invalid();
  const file = exact(data.timeline, ["fileId", "sha256", "byteLength"]), byteLength = sequence(file.byteLength);
  if (BigInt(byteLength) > BigInt(SESSION_ARCHIVE_TIMELINE_MAX_BYTES) || !Array.isArray(data.resources) || data.resources.length > 1000) return invalid();
  const ids = new Set<string>(); let bytes = 0n;
  const resources = data.resources.map(raw => { const item = exact(raw, ["resource", "blobId"]), resource = parseSessionResource(item.resource);
    if (ids.has(resource.resourceId) || resource.status === "pending") return invalid(); ids.add(resource.resourceId);
    const blobId = item.blobId === null ? null : uuid(item.blobId);
    if (resource.status === "available") { if (blobId === null || resource.byteLength === null || resource.sha256 === null || BigInt(resource.byteLength) > BigInt(SESSION_ARCHIVE_BLOB_MAX_BYTES)) return invalid(); bytes += BigInt(resource.byteLength); }
    else if (blobId !== null) return invalid(); return { resource, blobId };
  });
  if (bytes > 1073741824n || new TextEncoder().encode(JSON.stringify(data)).length > SESSION_ARCHIVE_MANIFEST_MAX_BYTES) return invalid();
  return { schemaVersion: 3, contentKind: "native_timeline", recordId: binding.sessionId, fence: binding, provider: data.provider as SessionProvider, nativeSessionId: data.nativeSessionId as string | null, controllerId: uuid(data.controllerId), controllerInstanceId: uuid(data.controllerInstanceId), timeline: { fileId: uuid(file.fileId), sha256: hash(file.sha256), byteLength }, resources, completeness: data.completeness as "complete" | "partial" };
};

export const parseSessionArchiveTimeline = (value: unknown): SessionArchiveTimeline => {
  const data = exact(value, ["entries"]);
  if (!Array.isArray(data.entries) || data.entries.length > 100000 || new TextEncoder().encode(JSON.stringify(data)).length > SESSION_ARCHIVE_TIMELINE_MAX_BYTES) return invalid();
  const entries = data.entries.map(parseTimelineEntry), ids = new Set<string>(); let previous = 0n;
  for (const entry of entries) { if (ids.has(entry.entryId) || BigInt(entry.entrySeq) <= previous) return invalid(); ids.add(entry.entryId); previous = BigInt(entry.entrySeq); }
  return { entries };
};

/** Traverse the complete persisted entry, including retained and reasoning bindings. */
export const sessionArchiveReferences = (entries: readonly TimelineEntry[], requireSealable = true): { resources: Set<string>; unavailable: boolean } => {
  const resources = new Set<string>(); let unavailable = false;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (requireSealable && (Object.hasOwn(item, "imageProjectionError") && item.imageProjectionError !== null || Object.hasOwn(item, "bindings") && item.bindings === null)) return invalid();
    if (item.type === "resource" || item.type === "image") { if (item.resourceId === null) unavailable = true; else resources.add(uuid(item.resourceId)); }
    if (item.type === "image_unavailable") unavailable = true;
    Object.values(item).forEach(visit);
  };
  entries.forEach(visit); return { resources, unavailable };
};
const digest = async (bytes: Uint8Array): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))), value => value.toString(16).padStart(2, "0")).join("");
export const verifySessionArchiveMetadata = async (manifest: SessionArchiveManifest, bytes: Uint8Array): Promise<SessionArchiveTimeline> => {
  if (String(bytes.byteLength) !== manifest.timeline.byteLength || await digest(bytes) !== manifest.timeline.sha256) return invalid();
  let raw: unknown; try { raw = decodeStrictSessionJson(bytes, SESSION_ARCHIVE_TIMELINE_MAX_BYTES); } catch { return invalid(); }
  const timeline = parseSessionArchiveTimeline(raw), refs = sessionArchiveReferences(timeline.entries), descriptors = new Map(manifest.resources.map(ref => [ref.resource.resourceId, ref]));
  for (const entry of timeline.entries) await verifyTimelineImageMetadata(entry);
  for (const id of refs.resources) if (!descriptors.has(id)) return invalid();
  for (const ref of manifest.resources) {
    if (!refs.resources.has(ref.resource.resourceId)) return invalid();
    if (ref.resource.status !== "available") { refs.unavailable = true; continue; }
  }
  if ((manifest.completeness === "partial") !== refs.unavailable) return invalid();
  return timeline;
};
export const verifySessionArchiveClosure = async (manifest: SessionArchiveManifest, bytes: Uint8Array, readBlob: (reference: SessionArchiveResourceReference) => Promise<Uint8Array>): Promise<SessionArchiveTimeline> => {
  const timeline = await verifySessionArchiveMetadata(manifest, bytes);
  for (const ref of manifest.resources) {
    if (ref.resource.status !== "available") continue;
    const original = await readBlob(ref);
    if (String(original.byteLength) !== ref.resource.byteLength || await digest(original) !== ref.resource.sha256) return invalid();
  }
  return timeline;
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
