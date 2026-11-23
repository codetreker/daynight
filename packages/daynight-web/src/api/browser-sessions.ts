import { ApiError, readAuthRequestGeneration, requestId, responseSignal } from './client';
import { credentialJson, credentialOperation, credentialRequest } from './credential-management';
import { array, id, malformed, nonemptyString, record, timestamp } from './parse';

export type BrowserSession = {
  readonly id: string;
  readonly browser: 'Chrome' | 'Edge' | 'Firefox' | 'Safari' | 'Opera' | null;
  readonly os: 'Windows' | 'macOS' | 'Linux' | 'Android' | 'iOS' | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string;
};
export type BrowserSessionPage = {
  readonly userId: string;
  readonly current: BrowserSession;
  readonly items: readonly BrowserSession[];
  readonly nextCursor: string | null;
};
export type BrowserSessionRevoke = { readonly expectedUserId: string; readonly expectedSessionId: string };

const base = '/api/v1/me/browser-sessions';
const exactFields = (data: Record<string, unknown>, fields: readonly string[]): void => {
  if (Object.keys(data).some(key => !fields.includes(key))) malformed();
};
const parseSession = (value: unknown): BrowserSession => {
  const data = record(value);
  exactFields(data, ['id', 'browser', 'os', 'createdAt', 'lastUsedAt', 'expiresAt']);
  const browser = data.browser, os = data.os;
  if (browser !== null && browser !== 'Chrome' && browser !== 'Edge' && browser !== 'Firefox' && browser !== 'Safari' && browser !== 'Opera') return malformed();
  if (os !== null && os !== 'Windows' && os !== 'macOS' && os !== 'Linux' && os !== 'Android' && os !== 'iOS') return malformed();
  return { id: id(data.id), browser, os, createdAt: timestamp(data.createdAt), lastUsedAt: data.lastUsedAt === null ? null : timestamp(data.lastUsedAt), expiresAt: timestamp(data.expiresAt) };
};

export const listBrowserSessions = (signal: AbortSignal, expectedUserId: string, onIdentityMismatch: () => void, cursor?: string): Promise<BrowserSessionPage> => credentialOperation(signal, async () => {
  const expected = requestId(expectedUserId);
  if (cursor !== undefined && (cursor === '' || !cursor.isWellFormed())) throw new ApiError('protocol');
  const query = cursor === undefined ? '' : `?${new URLSearchParams({ cursor }).toString()}`;
  const response = await credentialRequest(`${base}${query}`, signal, expected, onIdentityMismatch, { headers: { Accept: 'application/json' } });
  return credentialJson(response, signal, value => {
    if (response.status !== 200) return malformed();
    const data = record(value);
    exactFields(data, ['userId', 'current', 'items', 'nextCursor']);
    const userId = id(data.userId), current = parseSession(data.current), items = array(data.items, parseSession);
    if (userId !== expected || new Set([current.id, ...items.map(item => item.id)]).size !== items.length + 1) return malformed();
    const nextCursor = data.nextCursor === null ? null : nonemptyString(data.nextCursor);
    return { userId, current, items, nextCursor };
  });
});

export const getBrowserSession = (sessionId: string, signal: AbortSignal, expectedUserId: string, onIdentityMismatch: () => void): Promise<BrowserSession> => credentialOperation(signal, async () => {
  const target = requestId(sessionId);
  const response = await credentialRequest(`${base}/${target}`, signal, expectedUserId, onIdentityMismatch, { headers: { Accept: 'application/json' } });
  return credentialJson(response, signal, value => {
    if (response.status !== 200) return malformed();
    const session = parseSession(value);
    if (session.id !== target) return malformed();
    return session;
  });
});

export const revokeBrowserSession = (sessionId: string, input: BrowserSessionRevoke, signal: AbortSignal, onIdentityMismatch: () => void, onDispatch?: () => void): Promise<void> => credentialOperation(signal, async () => {
  const target = requestId(sessionId), expectedUserId = requestId(input.expectedUserId), expectedSessionId = requestId(input.expectedSessionId);
  if (target === expectedSessionId) throw new ApiError('protocol');
  const generation = readAuthRequestGeneration();
  const response = await credentialRequest(`${base}/${target}/revoke`, signal, expectedUserId, onIdentityMismatch, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedUserId, expectedSessionId }),
  }, onDispatch);
  responseSignal(response, signal).throwIfAborted();
  if (generation !== readAuthRequestGeneration()) throw new DOMException('The authenticated account changed.', 'AbortError');
  if (!response.ok) return credentialJson(response, signal, () => malformed());
  if (response.status !== 204) throw new ApiError('protocol', response.status);
});
