import { decodeSessionV2Archive } from '../../../daynight/src/session/v2/archive';
import { assertTerminalBinding, parseSessionV2Message, parseSessionV2Owner, parseTerminalBinding } from '../../../daynight/src/session/v2/protocol';
import { SESSION_V2_PROTOCOL, SESSION_PROTOCOL_HEADER, SESSION_V2_LIMITS, bool, byteLength, choice, decodeStrictSessionJson, exact, hash, hashSessionBytes, list, literal, nullable, seq, text, unique, uuid } from '../../../daynight/src/session/v2/values';
import type { SessionV2Archive, SessionV2Envelope, SessionV2Message, SessionV2Owner, SessionV2Payloads, TerminalBinding } from '../../../daynight/src/session/v2/types';
import { parseSessionArchive, parseSessionArchiveStatus, verifySessionArchiveResources, type SessionArchive, type SessionArchiveStatus } from '../../../daynight/src/session/archive';
import { ApiError, assertResponsePrincipal, json, request, requestId } from './client';

export type SessionHistoryItem = {
  sessionId: string; claimId: string; executionGeneration: string; agentControlMode: 'web' | 'herdr'; contentKind: 'native_timeline' | 'terminal_recording'; createdAt: string; endedAt: string | null;
  archive: { state: 'pending' | 'ready' | 'failed' | 'unavailable'; sha256: string | null; byteLength: string | null; completeness: 'complete' | 'partial' | null };
};
export type SessionRecordingReference = Pick<SessionHistoryItem, 'sessionId' | 'claimId' | 'executionGeneration' | 'agentControlMode'> & { readonly archive?: SessionHistoryItem['archive'] };
export type TerminalSessionState = SessionV2Envelope & {
  status: 'registered'; agentControlMode: 'herdr'; contentKind: 'terminal_recording'; owner: SessionV2Owner; binding: TerminalBinding; connectionEpoch: string; connected: boolean;
  capabilities: { observe: boolean; control: boolean; archive: boolean };
  control: SessionV2Payloads['control_state'] | null; snapshot: SessionV2Payloads['snapshot'] | null;
  ledger: SessionV2Payloads['generation_ledger']; archive: SessionV2Payloads['archive_status'];
  recording: { executionGeneration: string; responsibility: SessionV2Payloads['recording_responsibility'] | null; evidence: SessionV2Payloads['recording_evidence'] | null }[];
};
export type TerminalCurrent = TerminalSessionState | { status: 'not_registered'; protocol: typeof SESSION_V2_PROTOCOL; claimId: string; agentControlMode: 'herdr' } | { status: 'not_applicable'; protocol: typeof SESSION_V2_PROTOCOL };
export type TerminalResult = Extract<SessionV2Message, { type: 'operation_result' }>;
export type TerminalCommand = Extract<SessionV2Message, { type: 'operation' | 'control_request' }>;
export type TerminalArchive = { status: Extract<SessionV2Message, { type: 'archive_status' }>; archive: SessionV2Archive | null };
export type TerminalSessionApi = {
  current(signal: AbortSignal): Promise<TerminalCurrent>;
  state(sessionId: string, signal: AbortSignal): Promise<TerminalSessionState>;
  history(cursor: string | null, signal: AbortSignal): Promise<{ items: SessionHistoryItem[]; nextCursor: string | null }>;
  archive(item: SessionRecordingReference, signal: AbortSignal): Promise<TerminalArchive>;
  nativeArchive(item: SessionRecordingReference, signal: AbortSignal): Promise<{ status: SessionArchiveStatus; archive: SessionArchive | null }>;
  command(sessionId: string, browserClientId: string, message: TerminalCommand, signal: AbortSignal): Promise<TerminalResult>;
  operation(sessionId: string, operationId: string, signal: AbortSignal): Promise<TerminalResult>;
  channel(sessionId: string, browserClientId: string, onState: (state: TerminalSessionState) => void, onClose: (error?: unknown) => void): { close(): void };
};
const invalid = (): never => { throw new ApiError('protocol'); };
export const terminalEnvelope = (state: Pick<SessionV2Envelope, 'sessionId' | 'claimId' | 'executionGeneration'>) => ({ protocol: SESSION_V2_PROTOCOL, schemaVersion: 2 as const, projectionVersion: 1 as const, agentControlMode: 'herdr' as const, contentKind: 'terminal_recording' as const, sessionId: state.sessionId, claimId: state.claimId, executionGeneration: state.executionGeneration });
function payload<K extends keyof SessionV2Payloads>(state: SessionV2Envelope, kind: K, value: unknown): SessionV2Payloads[K] {
  return parseSessionV2Message({ ...terminalEnvelope(state), type: kind, payload: value }).payload as SessionV2Payloads[K];
}
function fence(value: SessionV2Envelope, expected: Pick<SessionV2Envelope, 'sessionId' | 'claimId' | 'executionGeneration'>) {
  if (value.sessionId !== expected.sessionId || value.claimId !== expected.claimId || value.executionGeneration !== expected.executionGeneration) invalid();
}
export function parseTerminalSessionState(value: unknown, projectId: string, taskId: string, serverOrigin: string): TerminalSessionState {
  const o = exact(value, ['status', 'protocol', 'schemaVersion', 'projectionVersion', 'sessionId', 'claimId', 'executionGeneration', 'agentControlMode', 'contentKind', 'owner', 'binding', 'connectionEpoch', 'connected', 'capabilities', 'control', 'snapshot', 'ledger', 'archive', 'recording']);
  const base = { protocol: literal(o.protocol, SESSION_V2_PROTOCOL), schemaVersion: literal(o.schemaVersion, 2), projectionVersion: literal(o.projectionVersion, 1), sessionId: uuid(o.sessionId), claimId: uuid(o.claimId), executionGeneration: seq(o.executionGeneration) };
  const owner = parseSessionV2Owner(o.owner), binding = parseTerminalBinding(o.binding), connectionEpoch = seq(o.connectionEpoch), caps = exact(o.capabilities, ['observe', 'control', 'archive']);
  if (owner.projectId !== projectId || owner.taskId !== taskId || owner.serverOrigin !== serverOrigin) invalid();
  const control = nullable(o.control, v => payload(base, 'control_state', v)), snapshot = nullable(o.snapshot, v => payload(base, 'snapshot', v));
  const ledger = payload(base, 'generation_ledger', o.ledger), archive = payload(base, 'archive_status', o.archive);
  if (control !== null && control.connectionEpoch !== connectionEpoch || snapshot !== null && snapshot.connectionEpoch !== connectionEpoch) invalid();
  if (snapshot !== null) assertTerminalBinding(binding, snapshot.binding);
  const last = ledger.runs.at(-1);
  if (!last || JSON.stringify(last.owner) !== JSON.stringify(owner)) return invalid();
  assertTerminalBinding(last.binding, binding);
  return { ...base, status: literal(o.status, 'registered'), agentControlMode: literal(o.agentControlMode, 'herdr'), contentKind: literal(o.contentKind, 'terminal_recording'), owner, binding, connectionEpoch, connected: bool(o.connected), capabilities: { observe: bool(caps.observe), control: bool(caps.control), archive: bool(caps.archive) }, control, snapshot, ledger, archive, recording: unique(list(o.recording, raw => { const r = exact(raw, ['executionGeneration', 'responsibility', 'evidence']); const executionGeneration = seq(r.executionGeneration); if (!ledger.runs.some(run => run.executionGeneration === executionGeneration)) invalid(); return { executionGeneration, responsibility: nullable(r.responsibility, v => payload(base, 'recording_responsibility', v)), evidence: nullable(r.evidence, v => payload(base, 'recording_evidence', v)) }; }), r => r.executionGeneration) };
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
async function boundedBytes(response: Response, signal: AbortSignal, max: number): Promise<Uint8Array> {
  if (!response.body) return invalid();
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(max))) { await response.body.cancel(); invalid(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const r = await reader.read(); signal.throwIfAborted(); if (r.done) break; size += r.value.byteLength; if (size > max) invalid(); chunks.push(r.value); } }
  finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes;
}
export function createTerminalSessionApi(projectId: string, taskId: string, userId: string, onPrincipalMismatch: () => void, serverOrigin = window.location.origin): TerminalSessionApi {
  const root = `/api/v1/projects/${requestId(projectId)}/tasks/${requestId(taskId)}/sessions`, path = (id: string) => `${root}/${requestId(id)}`;
  const parseState = (v: unknown) => parseTerminalSessionState(v, projectId, taskId, serverOrigin);
  async function get<T>(url: string, signal: AbortSignal, parse: (value: unknown) => T, init: RequestInit = {}, expected = 200, v2 = true): Promise<T> {
    const response = await request(url, signal, { ...init, headers: { Accept: 'application/json', ...(v2 ? { [SESSION_PROTOCOL_HEADER]: SESSION_V2_PROTOCOL } : {}), ...init.headers } });
    assertResponsePrincipal(response, userId, onPrincipalMismatch);
    return json(response, signal, v => { if (response.status !== expected) invalid(); return parse(v); }, async () => decodeStrictSessionJson(await boundedBytes(response, signal, SESSION_V2_LIMITS.archiveMaxBytes + 1024), SESSION_V2_LIMITS.archiveMaxBytes + 1024));
  }
  const result = (v: unknown, id: string, operationId: string) => { const r = parseSessionV2Message(v); if (r.type !== 'operation_result' || r.sessionId !== id || r.payload.operationId !== operationId) return invalid(); return r; };
  return {
    current: signal => get(`${root}/current`, signal, v => {
      if (v && typeof v === 'object' && 'status' in v && v.status === 'registered') return parseState(v);
      if (v && typeof v === 'object' && 'status' in v && v.status === 'not_registered') { const o = exact(v, ['status', 'protocol', 'claimId', 'agentControlMode']); return { status: literal(o.status, 'not_registered'), protocol: literal(o.protocol, SESSION_V2_PROTOCOL), claimId: uuid(o.claimId), agentControlMode: literal(o.agentControlMode, 'herdr') }; }
      const o = exact(v, ['status', 'protocol']); return { status: literal(o.status, 'not_applicable'), protocol: literal(o.protocol, SESSION_V2_PROTOCOL) };
    }),
    state: (id, signal) => get(`${path(id)}/state`, signal, v => { const state = parseState(v); if (state.sessionId !== id) invalid(); return state; }),
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
      const bytes = await boundedBytes(response, signal, SESSION_V2_LIMITS.archiveMaxBytes);
      if (String(bytes.length) !== status.payload.byteLength || await hashSessionBytes(bytes) !== status.payload.sha256) invalid();
      const archive = await decodeSessionV2Archive(bytes); fence({ ...terminalEnvelope(archive) }, item);
      if (archive.owner.projectId !== projectId || archive.owner.taskId !== taskId || archive.owner.serverOrigin !== serverOrigin || archive.finalizationId !== status.payload.finalizationId || archive.completeness !== status.payload.completeness) invalid();
      signal.throwIfAborted(); return { status, archive };
    },
    nativeArchive: async (item, signal) => {
      if (item.agentControlMode !== 'web') invalid();
      const status = await get(`${path(item.sessionId)}/archive`, signal, v => parseSessionArchiveStatus(exact(v, ['archive']).archive), {}, 200, false);
      if (item.archive?.state === 'ready' && (status.state !== 'ready' || status.sha256 !== item.archive.sha256 || status.byteLength !== item.archive.byteLength)) invalid();
      if (status.state !== 'ready') return { status, archive: null };
      // v1 wraps RawMessage through JSON encoding. Its server verifies original bytes;
      // reserializing the envelope cannot reproduce the uploaded byte hash.
      const archive = await get(`${path(item.sessionId)}/archive/content`, signal, v => parseSessionArchive(exact(v, ['archive']).archive), {}, 200, false);
      if (archive.sessionId !== item.sessionId || archive.claimId !== item.claimId || archive.executionGeneration !== item.executionGeneration) invalid();
      await verifySessionArchiveResources(archive); signal.throwIfAborted(); return { status, archive };
    },
    command: async (id, browser, message, signal) => {
      parseSessionV2Message(message); if (message.sessionId !== id) invalid();
      const r = await get(`${path(id)}/commands`, signal, v => result(v, id, message.payload.operationId), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Daynight-Browser-Client': requestId(browser) }, body: JSON.stringify(message) }, 202);
      fence(r, message); return r;
    },
    operation: (id, operationId, signal) => get(`${path(id)}/operations/${requestId(operationId)}`, signal, v => result(v, id, operationId)),
    channel: (id, browser, onState, onClose) => {
      const url = new URL(`${path(id)}/channel`, window.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('browserClientId', requestId(browser));
      const socket = new WebSocket(url, SESSION_V2_PROTOCOL); let closed = false;
      const timer = setTimeout(() => fail(new ApiError('network')), 10_000);
      const fail = (error?: unknown) => { if (closed) return; closed = true; clearTimeout(timer); socket.close(); onClose(error); };
      socket.onmessage = event => { if (closed) return; try { if (typeof event.data !== 'string') invalid(); const state = parseState(decodeStrictSessionJson(event.data, SESSION_V2_LIMITS.metadataMaxBytes)); if (state.sessionId !== id) invalid(); clearTimeout(timer); onState(state); } catch (error) { fail(error); } };
      socket.onclose = () => fail(); socket.onerror = () => fail(new ApiError('network'));
      return { close: () => { closed = true; clearTimeout(timer); socket.close(); } };
    },
  };
}
