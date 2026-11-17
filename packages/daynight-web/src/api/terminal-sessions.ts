import { awaitAbortable } from '../../../daynight/src/api/abort';
import { decodeSessionV2Archive } from '../../../daynight/src/session/v2/archive';
import { parseSessionV2Message } from '../../../daynight/src/session/v2/protocol';
import { SESSION_V2_PROTOCOL, SESSION_PROTOCOL_HEADER, SESSION_V2_LIMITS, byteLength, choice, decodeStrictSessionJson, exact, hash, hashSessionBytes, list, literal, nullable, seq, text, unique, uuid } from '../../../daynight/src/session/v2/values';
import type { SessionV2Archive, SessionV2Envelope, SessionV2Message } from '../../../daynight/src/session/v2/types';
import type { SessionArchiveStatus } from '../../../daynight/src/session/archive';
import { assertSessionFence } from '../../../daynight/src/session/protocol';
import { ApiError, assertResponsePrincipal, json, request, responseSignal, requestId } from './client';
import { createSessionApi, type LoadedSessionArchive, type SessionApi } from './sessions';

export type SessionHistoryItem = {
  sessionId: string; claimId: string; executionGeneration: string; agentControlMode: 'web' | 'herdr'; contentKind: 'native_timeline' | 'terminal_recording'; createdAt: string; endedAt: string | null;
  archive: { state: 'pending' | 'ready' | 'failed' | 'unavailable'; sha256: string | null; byteLength: string | null; completeness: 'complete' | 'partial' | null };
};
export type SessionRecordingReference = Pick<SessionHistoryItem, 'sessionId' | 'claimId' | 'executionGeneration' | 'agentControlMode'> & { readonly archive?: SessionHistoryItem['archive'] };
export type TerminalArchive = { status: Extract<SessionV2Message, { type: 'archive_status' }>; archive: SessionV2Archive | null };
export type TerminalSessionApi = {
  history(cursor: string | null, signal: AbortSignal): Promise<{ items: SessionHistoryItem[]; nextCursor: string | null }>;
  archive(item: SessionRecordingReference, signal: AbortSignal): Promise<TerminalArchive>;
  nativeArchive(item: SessionRecordingReference, signal: AbortSignal): Promise<{ status: SessionArchiveStatus; archive: LoadedSessionArchive | null }>;
  resources: SessionApi['resources'];
};
const invalid = (): never => { throw new ApiError('protocol'); };
export const terminalEnvelope = (state: Pick<SessionV2Envelope, 'sessionId' | 'claimId' | 'executionGeneration'>) => ({ protocol: SESSION_V2_PROTOCOL, schemaVersion: 2 as const, projectionVersion: 1 as const, agentControlMode: 'herdr' as const, contentKind: 'terminal_recording' as const, sessionId: state.sessionId, claimId: state.claimId, executionGeneration: state.executionGeneration });
function fence(value: SessionV2Envelope, expected: Pick<SessionV2Envelope, 'sessionId' | 'claimId' | 'executionGeneration'>) {
  if (value.sessionId !== expected.sessionId || value.claimId !== expected.claimId || value.executionGeneration !== expected.executionGeneration) invalid();
}
function nanoTimestamp(value: unknown): string {
  const s = text(value, 30); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 19) !== s.slice(0, 19)) invalid(); return s;
}
export function parseSessionHistory(value: unknown): { items: SessionHistoryItem[]; nextCursor: string | null } {
  const o = exact(value, ['items', 'nextCursor']);
  const items = unique(list(o.items, raw => {
    const r = exact(raw, ['sessionId', 'claimId', 'executionGeneration', 'agentControlMode', 'contentKind', 'createdAt', 'endedAt', 'archive']), a = exact(r.archive, ['state', 'sha256', 'byteLength', 'completeness']);
    const agentControlMode = choice(r.agentControlMode, ['web', 'herdr']), contentKind = choice(r.contentKind, ['native_timeline', 'terminal_recording']);
    if ((agentControlMode === 'herdr') !== (contentKind === 'terminal_recording')) invalid();
    const state = choice(a.state, ['pending', 'ready', 'failed', 'unavailable']), sha256 = nullable(a.sha256, hash), size = nullable(a.byteLength, v => byteLength(v)), completeness = nullable(a.completeness, v => choice(v, ['complete', 'partial'] as const));
    if (state === 'ready' ? sha256 === null || size === null || agentControlMode === 'herdr' && completeness === null : sha256 !== null || size !== null || completeness !== null) invalid();
    return { sessionId: uuid(r.sessionId), claimId: uuid(r.claimId), executionGeneration: seq(r.executionGeneration), agentControlMode, contentKind, createdAt: nanoTimestamp(r.createdAt), endedAt: nullable(r.endedAt, nanoTimestamp), archive: { state, sha256, byteLength: size, completeness } };
  }, 200), item => item.sessionId);
  return { items, nextCursor: nullable(o.nextCursor, v => text(v, 1024)) };
}
// The HTTP status is trusted only after the principal check (or the 401 lifecycle).
export class SessionDenialProtocolError extends ApiError {
  constructor(error: ApiError) { super(error.kind, error.status, error.code, error.requestId, error); }
}
async function boundedBytes(response: Response, signal: AbortSignal, max: number): Promise<Uint8Array> {
  signal = responseSignal(response, signal);
  signal.throwIfAborted();
  if (!response.body) return invalid();
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(max))) { await awaitAbortable(response.body.cancel().catch(() => undefined), signal); signal.throwIfAborted(); invalid(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  let cancelled = false;
  const cancel = () => { cancelled = true; void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try { signal.throwIfAborted(); for (;;) { const r = await reader.read(); signal.throwIfAborted(); if (r.done) break; size += r.value.byteLength; if (size > max) invalid(); chunks.push(r.value); } }
  catch (error) { signal.throwIfAborted(); throw error; }
  finally { signal.removeEventListener('abort', cancel); if (!cancelled) void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes;
}
export function createTerminalSessionApi(projectId: string, taskId: string, userId: string, onPrincipalMismatch: () => void, serverOrigin = window.location.origin): TerminalSessionApi {
  const root = `/api/v1/projects/${requestId(projectId)}/tasks/${requestId(taskId)}/sessions`, path = (id: string) => `${root}/${requestId(id)}`;
  const native = createSessionApi(projectId, taskId, userId, onPrincipalMismatch);
  async function get<T>(url: string, signal: AbortSignal, parse: (value: unknown) => T, init: RequestInit = {}, expected = 200, v2 = true): Promise<T> {
    const response = await request(url, signal, { ...init, headers: { Accept: 'application/json', ...(v2 ? { [SESSION_PROTOCOL_HEADER]: SESSION_V2_PROTOCOL } : {}), ...init.headers } });
    assertResponsePrincipal(response, userId, onPrincipalMismatch);
    try {
      return await json(response, signal, v => { if (response.status !== expected) invalid(); return parse(v); }, async () => decodeStrictSessionJson(await boundedBytes(response, signal, SESSION_V2_LIMITS.archiveMaxBytes + 1024), SESSION_V2_LIMITS.archiveMaxBytes + 1024));
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'protocol' && [401, 403, 404, 410].includes(response.status)) throw new SessionDenialProtocolError(error);
      throw error;
    }
  }
  return {
    resources: native.resources,
    history: (cursor, signal) => get(`${root}?limit=50${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, signal, parseSessionHistory),
    archive: async (item, signal) => {
      if (item.agentControlMode !== 'herdr') invalid();
      const status = await get(`${path(item.sessionId)}/archive`, signal, v => { const m = parseSessionV2Message(v); if (m.type !== 'archive_status') return invalid(); fence(m, item); return m; });
      if (item.archive?.state === 'ready' && (status.payload.state !== 'ready' || status.payload.sha256 !== item.archive.sha256 || status.payload.byteLength !== item.archive.byteLength || status.payload.completeness !== item.archive.completeness)) invalid();
      if (status.payload.state !== 'ready') return { status, archive: null };
      const response = await request(`${path(item.sessionId)}/archive/content`, signal, { headers: { Accept: 'application/json', [SESSION_PROTOCOL_HEADER]: SESSION_V2_PROTOCOL } });
      assertResponsePrincipal(response, userId, onPrincipalMismatch);
      if (!response.ok) return json(response, signal, () => invalid());
      if (response.status !== 200 || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('Content-Type') ?? '')) invalid();
      const lifetime = responseSignal(response, signal);
      try {
        const bytes = await boundedBytes(response, lifetime, SESSION_V2_LIMITS.archiveMaxBytes);
        const digest = await hashSessionBytes(bytes);
        lifetime.throwIfAborted();
        if (String(bytes.length) !== status.payload.byteLength || digest !== status.payload.sha256) invalid();
        const archive = await decodeSessionV2Archive(bytes);
        lifetime.throwIfAborted();
        fence({ ...terminalEnvelope(archive) }, item);
        if (archive.owner.projectId !== projectId || archive.owner.taskId !== taskId || archive.owner.serverOrigin !== serverOrigin || archive.finalizationId !== status.payload.finalizationId || archive.completeness !== status.payload.completeness) invalid();
        return { status, archive };
      } catch (error) { lifetime.throwIfAborted(); throw error; }
    },
    nativeArchive: async (item, signal) => {
      if (item.agentControlMode !== 'web') invalid();
      const status = await native.archive(item.sessionId, signal);
      if (item.archive?.state === 'ready' && (status.state !== 'ready' || status.sha256 !== item.archive.sha256 || status.byteLength !== item.archive.byteLength || item.archive.completeness !== null && status.completeness !== item.archive.completeness)) invalid();
      if (status.state !== 'ready') return { status, archive: null };
      const archive = await native.archiveContent(item.sessionId, signal, status);
      assertSessionFence(archive, item);
      if ((status.schemaVersion ?? 1) !== archive.schemaVersion || archive.schemaVersion === 3 && status.completeness !== archive.completeness) invalid();
      signal.throwIfAborted(); return { status, archive };
    },

  };
}
