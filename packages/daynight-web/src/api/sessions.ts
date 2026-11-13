import { awaitAbortable } from '../../../daynight/src/api/abort';
import { parseSessionArchive, parseSessionArchiveStatus, parseSessionArchiveManifest, verifySessionArchiveMetadata, verifySessionArchiveResources, SESSION_ARCHIVE_MAX_BYTES, SESSION_ARCHIVE_TIMELINE_MAX_BYTES, SESSION_ARCHIVE_MANIFEST_MAX_BYTES, type SessionArchive, type SessionArchiveStatus, type SessionArchiveResourceReference } from '../../../daynight/src/session/archive';
import { createSessionResourceClient, type SessionResourceClient } from '../../../daynight/src/session/resource-client';
import { decodeStrictSessionJson } from '../../../daynight/src/session/v2/values';
import { STARTUP_REPORT_HEADER } from '../../../daynight/src/session/startup';
import { ApiError, assertResponsePrincipal, json, request, responseSignal, requestId, readAuthRequestGeneration } from './client';
export { listTestSessions, parseTestSessionList, type TestSessionSummary, type TestSessionList } from './test-sessions';
import { parseBrowserMessage, parseCommandResponse, parseRegistrationResponse, parseCurrentSessionResponse, parseOperationResponse, parseTaskOperationResponse, parseTimelinePage, RELAY_LIMITS,
  type BrowserMessage, type CurrentSessionResponse, type OperationResponse, type TimelinePage } from '../../../daynight/src/session/controller-protocol';
import { assertSessionFence, parseSessionCommand, type SessionCommand, type SessionOperation, type SessionFence } from '../../../daynight/src/session/protocol';

export type LoadedSessionArchive = SessionArchive | (SessionFence & Pick<SessionArchive, 'controllerId' | 'controllerInstanceId' | 'provider' | 'nativeSessionId' | 'entries'> & {
  readonly schemaVersion: 3;
  readonly resources: readonly SessionArchiveResourceReference[];
  readonly completeness: 'complete' | 'partial';
});

export type SessionChannel = { close(): void };
/** An authenticated independent-current read rejected continued access, not an operation fence. */
export class IndependentSessionReadDenied extends ApiError {
  constructor(error: ApiError) { super('server', error.status, error.code, error.requestId, error); this.name = 'IndependentSessionReadDenied'; }
}
export type BotSessionBinding = {
  readonly ownerUserId: string;
  readonly botId: string;
  readonly sessionId: string;
  readonly testExecutionId: string;
};
export type SessionApi = {
  archive(sessionId: string, signal: AbortSignal): Promise<SessionArchiveStatus>;
  archiveContent(sessionId: string, signal: AbortSignal, expectedStatus?: SessionArchiveStatus): Promise<LoadedSessionArchive>;
  resources(fence: SessionFence, isCurrent: () => boolean): SessionResourceClient;
  current(signal: AbortSignal): Promise<CurrentSessionResponse>;
  timeline(sessionId: string, direction: 'tail' | 'before' | 'after', cursor: string | null, signal: AbortSignal): Promise<TimelinePage>;
  command(sessionId: string, command: SessionCommand, signal: AbortSignal): Promise<SessionOperation>;
  operation(sessionId: string, operationId: string, signal: AbortSignal): Promise<SessionOperation>;
  channel(sessionId: string, after: string | null, onMessage: (message: BrowserMessage) => void, onClose: (error?: unknown) => void): SessionChannel;
  resource(sessionId: string, resourceId: string, signal: AbortSignal, onProgress?: () => void): Promise<Blob>;
  resourceUrl(sessionId: string, resourceId: string): string;
};
export function createSessionApi(projectId: string, taskId: string, userId: string, onPrincipalMismatch: () => void): SessionApi {
  const root = `/api/v1/projects/${requestId(projectId)}/tasks/${requestId(taskId)}/sessions`;
  return createBoundSessionApi(`${root}/current`, (id) => `${root}/${requestId(id)}`, userId, onPrincipalMismatch, parseCurrentSessionResponse, parseTaskOperationResponse, { [STARTUP_REPORT_HEADER]: '1' });
}
export function createTestSessionApi(sessionId: string, userId: string, onPrincipalMismatch: () => void): SessionApi {
  return createIndependentSessionApi(sessionId, userId, onPrincipalMismatch);
}
/** Bind Bot management's confirmed identity to the existing independent Session transport. */
export function createBotSessionApi(binding: BotSessionBinding, onPrincipalMismatch: () => void): SessionApi {
  requestId(binding.botId);
  return createIndependentSessionApi(requestId(binding.sessionId), requestId(binding.ownerUserId), onPrincipalMismatch, requestId(binding.testExecutionId));
}
function createIndependentSessionApi(sessionId: string, userId: string, onPrincipalMismatch: () => void, testExecutionId?: string): SessionApi {
  const root = `/api/v1/test-sessions/${requestId(sessionId)}`;
  const api = createBoundSessionApi(root, (id) => {
    if (id !== sessionId) throw new ApiError('protocol');
    return root;
  }, userId, onPrincipalMismatch, (value) => {
    const { session } = parseRegistrationResponse(value);
    if (session.sessionId !== sessionId || !session.testExecutionId || session.identity.ownerUserId !== userId || testExecutionId !== undefined && session.testExecutionId !== testExecutionId) throw new ApiError('protocol');
    return { status: 'registered', session };
  }, parseOperationResponse);
  return { ...api, current: async signal => {
    try { return await api.current(signal); }
    catch (error) {
      // This read carries no mutable version/fence. A Bot deletion barrier uses
      // resource_conflict here, including access through a retained Test URL.
      if (error instanceof ApiError && error.kind === 'server' && error.status === 409 && error.code === 'resource_conflict') throw new IndependentSessionReadDenied(error);
      throw error;
    }
  } };
}
function createBoundSessionApi(currentUrl: string, sessionRoot: (id: string) => string, userId: string, onPrincipalMismatch: () => void, parseCurrent: (value: unknown) => CurrentSessionResponse, parseOperation: (value: unknown) => OperationResponse, currentHeaders: Readonly<Record<string, string>> = {}): SessionApi {
  async function get<T>(url: string, signal: AbortSignal, parse: (value: unknown) => T, init: RequestInit = {}, expectedStatus = 200): Promise<T> {
    const response = await request(url, signal, { ...init, headers: { Accept: 'application/json', ...init.headers } });
    assertResponsePrincipal(response, userId, onPrincipalMismatch);
    return json(response, signal, (value) => { if (response.status !== expectedStatus) throw new ApiError('protocol', response.status); return parse(value); });
  }
  const resources = (fence: SessionFence, isCurrent: () => boolean): SessionResourceClient => {
    const generation = readAuthRequestGeneration();
    return createSessionResourceClient({
      scope: { serverOrigin: window.location.origin, actorUserId: userId, fence, authorizationGeneration: String(generation) },
      baseUrl: new URL(sessionRoot(fence.sessionId), window.location.href).href,
      isCurrent: () => generation === readAuthRequestGeneration() && isCurrent(),
      onPrincipalMismatch,
      responseSignal,
      transport: async (url, signal, init) => {
        const response = await request(url, signal, init);
        assertResponsePrincipal(response, userId, onPrincipalMismatch);
        if (!response.ok) return json(response, signal, () => { throw new ApiError('protocol', response.status); });
        return response;
      },
    });
  };
  return {
    resources,
    archive: (id, signal) => get(`${sessionRoot(id)}/archive`, signal, (value) => parseSessionArchiveStatus(archiveEnvelope(value))),
    archiveContent: async (id, signal, expectedStatus) => {
      const generation = readAuthRequestGeneration();
      let lifetime = signal;
      const assertCurrent = () => {
        lifetime.throwIfAborted();
        if (generation !== readAuthRequestGeneration()) throw new DOMException('The authenticated account changed.', 'AbortError');
      };
      try {
        const response = await request(`${sessionRoot(id)}/archive/content`, signal, { headers: { Accept: 'application/json' } });
        lifetime = responseSignal(response, signal);
        assertCurrent();
        assertResponsePrincipal(response, userId, onPrincipalMismatch);
        let rawBytes: Uint8Array<ArrayBuffer> = new Uint8Array();
        const archive = await json(response, signal, value => {
          if (response.status !== 200) throw new ApiError('protocol', response.status);
          if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 3) return parseSessionArchiveManifest(value);
          const archive = parseSessionArchive(archiveEnvelope(value));
          if (archive.sessionId !== id) throw new ApiError('protocol');
          return archive;
        }, async () => { rawBytes = await boundedArchiveBytes(response, signal, SESSION_ARCHIVE_MAX_BYTES + 1024); return decodeStrictSessionJson(rawBytes, SESSION_ARCHIVE_MAX_BYTES + 1024); });
        assertCurrent();
        if (archive.schemaVersion === 3) {
          if (archive.recordId !== id) throw new ApiError('protocol');
          const status = expectedStatus ?? await get(`${sessionRoot(id)}/archive`, lifetime, value => parseSessionArchiveStatus(archiveEnvelope(value)));
          const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', rawBytes)), b => b.toString(16).padStart(2, '0')).join('');
          assertCurrent();
          if (rawBytes.byteLength > SESSION_ARCHIVE_MANIFEST_MAX_BYTES || status.state !== 'ready' || status.schemaVersion !== 3 || status.completeness !== archive.completeness || status.byteLength !== String(rawBytes.byteLength) || status.sha256 !== digest) throw new ApiError('protocol');
          const timelineResponse = await request(`${sessionRoot(id)}/archive/files/${requestId(archive.timeline.fileId)}`, lifetime, { headers: { Accept: 'application/json' } });
          assertCurrent();
          lifetime = responseSignal(timelineResponse, lifetime);
          assertCurrent();
          assertResponsePrincipal(timelineResponse, userId, onPrincipalMismatch);
          if (timelineResponse.status !== 200) return json(timelineResponse, signal, () => { throw new ApiError('protocol', timelineResponse.status); });
          const bytes = await boundedArchiveBytes(timelineResponse, signal, SESSION_ARCHIVE_TIMELINE_MAX_BYTES);
          assertCurrent();
          const timeline = await verifySessionArchiveMetadata(archive, bytes);
          assertCurrent();
          return { schemaVersion: 3, ...archive.fence, controllerId: archive.controllerId, controllerInstanceId: archive.controllerInstanceId, provider: archive.provider, nativeSessionId: archive.nativeSessionId, entries: timeline.entries, resources: archive.resources, completeness: archive.completeness };
        }
        if (expectedStatus && (expectedStatus.state !== 'ready' || (expectedStatus.schemaVersion ?? 1) !== archive.schemaVersion)) throw new ApiError('protocol');
        await verifySessionArchiveResources(archive);
        assertCurrent();
        return archive;
      } catch (error) { lifetime.throwIfAborted(); throw error; }
    },
    current: (signal) => get(currentUrl, signal, parseCurrent, { headers: currentHeaders }),
    timeline: (id, direction, cursor, signal) => {
      const params = new URLSearchParams({ direction, limit: '100' });
      if (cursor !== null) params.set('cursor', cursor);
      if (direction !== 'tail' && cursor === null) return Promise.reject(new ApiError('protocol'));
      return get(`${sessionRoot(id)}/timeline?${params}`, signal, parseTimelinePage);
    },
    command: async (id, command, signal) => {
      parseSessionCommand(command);
      if (id !== command.sessionId) throw new ApiError('protocol');
      const { operation } = await get(`${sessionRoot(id)}/commands`, signal, parseCommandResponse, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) }, 202);
      assertSessionFence(operation, command);
      if (operation.operationId !== command.operationId || operation.kind !== command.kind) throw new ApiError('protocol');
      return operation;
    },
    operation: async (id, operationId, signal) => {
      const { operation } = await get(`${sessionRoot(id)}/operations/${requestId(operationId)}`, signal, parseOperation);
      if (operation.sessionId !== id || operation.operationId !== operationId) throw new ApiError('protocol');
      return operation;
    },
    resource: async (id, resourceId, signal, onProgress) => {
      const response = await request(`${sessionRoot(id)}/resources/${requestId(resourceId)}/content`, signal);
      assertResponsePrincipal(response, userId, onPrincipalMismatch);
      if (!response.ok) return json(response, signal, () => { throw new ApiError('protocol', response.status); });
      if (response.status !== 200 || !response.body) throw new ApiError('protocol', response.status);
      const lifetime = responseSignal(response, signal);
      const reader = response.body.getReader(); const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
      let cancelled = false;
      const cancel = () => { cancelled = true; void reader.cancel(lifetime.reason).catch(() => undefined); };
      lifetime.addEventListener('abort', cancel, { once: true });
      try {
        lifetime.throwIfAborted();
        while (true) { const result = await reader.read(); lifetime.throwIfAborted(); if (result.done) break; size += result.value.byteLength; if (size > RELAY_LIMITS.maxResourceBytes) throw new ApiError('protocol'); chunks.push(new Uint8Array(result.value)); if (result.value.byteLength > 0) onProgress?.(); }
        return new Blob(chunks, { type: response.headers.get('Content-Type') ?? 'application/octet-stream' });
      } catch (error) { lifetime.throwIfAborted(); throw error; }
      finally { lifetime.removeEventListener('abort', cancel); if (!cancelled) void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    },
    resourceUrl: (id, resourceId) => `${sessionRoot(id)}/resources/${requestId(resourceId)}/content`,
    channel: (id, after, onMessage, onClose) => {
      const url = new URL(`${sessionRoot(id)}/channel`, window.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      if (after !== null) url.searchParams.set('after', after);
      const socket = new WebSocket(url);
      let closed = false; let authenticated = false;
      const handshake = setTimeout(() => fail(new ApiError('network')), 10_000);
      const fail = (error?: unknown) => { if (closed) return; closed = true; clearTimeout(handshake); socket.close(); onClose(error); };
      socket.onmessage = (event: MessageEvent<unknown>) => {
        if (closed) return;
        try {
          if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > RELAY_LIMITS.maxFrameBytes) throw new ApiError('protocol');
          const value = parseBrowserMessage(JSON.parse(event.data));
          if (!authenticated && value.type !== 'snapshot' && value.type !== 'reset_required') throw new ApiError('protocol');
          if (value.type === 'snapshot') { authenticated = true; clearTimeout(handshake); }
          onMessage(value);
        } catch (error) { fail(error); }
      };
      socket.onclose = () => fail(); socket.onerror = () => fail(new ApiError('network'));
      return { close: () => { closed = true; clearTimeout(handshake); socket.close(); } };
    },
  };
}

function archiveEnvelope(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('archive' in value) || Object.keys(value).length !== 1) throw new ApiError('protocol');
  return value.archive;
}
async function boundedArchiveBytes(response: Response, signal: AbortSignal, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  signal = responseSignal(response, signal);
  signal.throwIfAborted();
  if (!response.body) throw new ApiError('protocol');
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^[0-9]+$/.test(length) || BigInt(length) > BigInt(limit))) { await awaitAbortable(response.body.cancel().catch(() => undefined), signal); signal.throwIfAborted(); throw new ApiError('protocol'); }
  const reader = response.body.getReader(); const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
  let cancelled = false;
  const cancel = () => { cancelled = true; void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const result = await reader.read(); signal.throwIfAborted();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) throw new ApiError('protocol');
      chunks.push(new Uint8Array(result.value));
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) { signal.throwIfAborted(); throw error; }
  finally { signal.removeEventListener('abort', cancel); if (!cancelled) void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
