import { ApiError, assertResponsePrincipal, json, request, requestId } from './client';
export { listTestSessions, parseTestSessionList, type TestSessionSummary, type TestSessionList } from './test-sessions';
import { parseBrowserMessage, parseCommandResponse, parseRegistrationResponse, parseCurrentSessionResponse, parseOperationResponse, parseTimelinePage, RELAY_LIMITS,
  type BrowserMessage, type CurrentSessionResponse, type TimelinePage } from '../../../daynight/src/session/controller-protocol';
import { assertSessionFence, parseSessionCommand, type SessionCommand, type SessionOperation } from '../../../daynight/src/session/protocol';

export type SessionChannel = { close(): void };
export type SessionApi = {
  current(signal: AbortSignal): Promise<CurrentSessionResponse>;
  timeline(sessionId: string, direction: 'tail' | 'before' | 'after', cursor: string | null, signal: AbortSignal): Promise<TimelinePage>;
  command(sessionId: string, command: SessionCommand, signal: AbortSignal): Promise<SessionOperation>;
  operation(sessionId: string, operationId: string, signal: AbortSignal): Promise<SessionOperation>;
  channel(sessionId: string, after: string | null, onMessage: (message: BrowserMessage) => void, onClose: (error?: unknown) => void): SessionChannel;
  resource(sessionId: string, resourceId: string, signal: AbortSignal): Promise<Blob>;
  resourceUrl(sessionId: string, resourceId: string): string;
};
export function createSessionApi(projectId: string, taskId: string, userId: string, onPrincipalMismatch: () => void): SessionApi {
  const root = `/api/v1/projects/${requestId(projectId)}/tasks/${requestId(taskId)}/sessions`;
  return createBoundSessionApi(`${root}/current`, (id) => `${root}/${requestId(id)}`, userId, onPrincipalMismatch, parseCurrentSessionResponse);
}
export function createTestSessionApi(sessionId: string, userId: string, onPrincipalMismatch: () => void): SessionApi {
  const root = `/api/v1/test-sessions/${requestId(sessionId)}`;
  return createBoundSessionApi(root, (id) => {
    if (id !== sessionId) throw new ApiError('protocol');
    return root;
  }, userId, onPrincipalMismatch, (value) => {
    const { session } = parseRegistrationResponse(value);
    if (session.sessionId !== sessionId || !session.testExecutionId || session.identity.ownerUserId !== userId) throw new ApiError('protocol');
    return { status: 'registered', session };
  });
}
function createBoundSessionApi(currentUrl: string, sessionRoot: (id: string) => string, userId: string, onPrincipalMismatch: () => void, parseCurrent: (value: unknown) => CurrentSessionResponse): SessionApi {
  async function get<T>(url: string, signal: AbortSignal, parse: (value: unknown) => T, init: RequestInit = {}, expectedStatus = 200): Promise<T> {
    const response = await request(url, signal, { ...init, headers: { Accept: 'application/json', ...init.headers } });
    assertResponsePrincipal(response, userId, onPrincipalMismatch);
    return json(response, signal, (value) => { if (response.status !== expectedStatus) throw new ApiError('protocol', response.status); return parse(value); });
  }
  return {
    current: (signal) => get(currentUrl, signal, parseCurrent),
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
      const { operation } = await get(`${sessionRoot(id)}/operations/${requestId(operationId)}`, signal, parseOperationResponse);
      if (operation.sessionId !== id || operation.operationId !== operationId) throw new ApiError('protocol');
      return operation;
    },
    resource: async (id, resourceId, signal) => {
      const response = await request(`${sessionRoot(id)}/resources/${requestId(resourceId)}/content`, signal);
      assertResponsePrincipal(response, userId, onPrincipalMismatch);
      if (!response.ok) return json(response, signal, () => { throw new ApiError('protocol', response.status); });
      if (response.status !== 200 || !response.body) throw new ApiError('protocol', response.status);
      const reader = response.body.getReader(); const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
      try {
        while (true) { const result = await reader.read(); signal.throwIfAborted(); if (result.done) break; size += result.value.byteLength; if (size > RELAY_LIMITS.maxResourceBytes) throw new ApiError('protocol'); chunks.push(new Uint8Array(result.value)); }
        return new Blob(chunks, { type: response.headers.get('Content-Type') ?? 'application/octet-stream' });
      } finally { await reader.cancel(); reader.releaseLock(); }
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
