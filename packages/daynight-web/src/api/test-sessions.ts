import { ApiError, assertResponsePrincipal, json, request } from './client';
import { id, malformed, record, timestamp } from './parse';

export type TestSessionSummary = {
  readonly sessionId: string;
  readonly provider: 'codex' | 'claude' | 'copilot';
  readonly lifecycle: 'active' | 'draining' | 'archived';
  readonly connectionState: 'connected' | 'disconnected' | 'synchronizing';
  readonly createdAt: string;
  readonly updatedAt: string;
};
export type TestSessionList = { readonly items: readonly TestSessionSummary[]; readonly nextCursor: string | null };
const fields = (value: unknown, names: readonly string[]) => {
  const data = record(value);
  if (Object.keys(data).length !== names.length || names.some(name => !Object.hasOwn(data, name))) return malformed();
  return data;
};
const choice = <T extends string>(value: unknown, choices: readonly T[]): T => typeof value === 'string' && choices.includes(value as T) ? value as T : malformed();
export const parseTestSessionList = (value: unknown): TestSessionList => {
  const data = fields(value, ['items', 'nextCursor']);
  if (!Array.isArray(data.items) || data.items.length > 100) return malformed();
  const items = data.items.map((value): TestSessionSummary => {
    const item = fields(value, ['sessionId', 'provider', 'lifecycle', 'connectionState', 'createdAt', 'updatedAt']);
    return { sessionId: id(item.sessionId), provider: choice(item.provider, ['codex', 'claude', 'copilot']), lifecycle: choice(item.lifecycle, ['active', 'draining', 'archived']), connectionState: choice(item.connectionState, ['connected', 'disconnected', 'synchronizing']), createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt) };
  });
  if (new Set(items.map(item => item.sessionId)).size !== items.length) return malformed();
  const nextCursor = data.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length === 0 || nextCursor.length > 4096 || /[\u0000-\u001f\u007f]/u.test(nextCursor))) return malformed();
  return { items, nextCursor };
};
export const listTestSessions = async (userId: string, cursor: string | null, signal: AbortSignal, onPrincipalMismatch: () => void): Promise<TestSessionList> => {
  const params = new URLSearchParams({ limit: '50', online: 'true' });
  if (cursor !== null) params.set('cursor', cursor);
  const response = await request(`/api/v1/test-sessions?${params}`, signal, { headers: { Accept: 'application/json' } });
  assertResponsePrincipal(response, userId, onPrincipalMismatch);
  return json(response, signal, value => {
    if (response.status !== 200) throw new ApiError('protocol', response.status);
    const page = parseTestSessionList(value);
    if (cursor !== null && page.nextCursor === cursor) throw new ApiError('protocol');
    return page;
  });
};
