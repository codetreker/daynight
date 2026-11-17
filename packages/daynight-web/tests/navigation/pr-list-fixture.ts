import type { Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

export const projectId = '00000000-0000-4000-8000-000000000031';
const personalId = '00000000-0000-4000-8000-000000000701';
const at = '2026-11-13T08:00:00Z';
export type Scene = 'populated' | 'empty' | 'notconnected' | 'initial' | 'read-error' | 'stale' | 'unavailable' | 'disconnected';
const description = '## Description\n\n' + Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1}: preserve readable Markdown and Unicode 中文🙂.`).join('\n\n');

export const records = Array.from({ length: 48 }, (_, index) => ({
  number: String(1248 - index), id: String(9000 + index), url: `https://github.com/codetreker/daynight/pull/${1248 - index}`,
  title: index === 0 ? 'Preserve project PR details with Unicode 中文 and long branch names' : `Pull request ${1248 - index}`,
  author: index === 4 ? null : index >= 42 ? { id: '9001', login: 'very-long-github-username-for-testing-visibility-and-wrapping' } : { id: '42', login: 'author' }, state: index < 12 ? 'open' : index < 40 ? 'merged' : 'closed', draft: [2, 5, 9].includes(index),
  base: { repositoryId: '10', repositoryFullName: 'codetreker/daynight', ref: 'main' },
  head: { repositoryId: index === 4 ? null : '11', repositoryFullName: index === 4 ? null : 'international-platform-engineering/daynight-project-collaboration-runtime',
    ref: index === 4 ? null : 'fix/preserve-project-pr-description-and-stable-repository-identity-during-background-reconciliation', sha: '1234567890123456789012345678901234567890' },
  createdAt: at, updatedAt: at, closedAt: index < 12 ? null : at, mergedAt: index >= 12 && index < 40 ? at : null, observedAt: at, revision: '1',
}));
export const authors = [
  { id: '42', login: 'author', loginAmbiguous: false },
  ...Array.from({ length: 102 }, (_, index) => ({ id: String(100 + index), login: `creator${String(index).padStart(3, '0')}`, loginAmbiguous: false })),
  { id: '9001', login: 'very-long-github-username-for-testing-visibility-and-wrapping', loginAmbiguous: false },
];

export const installPrList = async (page: Page, locale: 'en' | 'zh-CN' = 'en') => {
  const task = detailFixture(projectId, '00000000-0000-4000-8000-000000000041', { title: 'Existing task' });
  const graph = graphFixture([task]);
  const state = { scene: 'populated' as Scene, syncOff: false, longCounts: false, revision: 1, graphFailure: false, authorError: false, pageReads: [] as string[], authorReads: [] as string[], detailReads: 0, statusReads: 0, unexpected: [] as string[] };
  const cursors = new Map<string, { offset: number; state: string; query: string; authorId: string | null }>();
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    const fault = (code = 'internal_error') => ({ error: { code, message: 'Fixture read failure', requestId: 'pr-list-fixture' } });
    if (request.method() !== 'GET') { state.unexpected.push(`${request.method()} ${path}`); return route.abort(); }
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/webhook-event-types') return send(fault('not_found'), 404);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: at, updatedAt: at, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: at, updatedAt: at } });
    if (path === `/api/v1/projects/${projectId}`) return send(graph.project);
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/tags`) return send({ items: [], catalogEpoch: '00000000-0000-4000-8000-000000000062', nextCursor: null });
    if (path === `/api/v1/projects/${projectId}/task-sync`) return state.graphFailure ? send(fault(), 500) : send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => 1n }));
    if (path === `/api/v1/projects/${projectId}/github`) {
      state.statusReads++;
      if (state.scene === 'read-error') return send(fault(), 500);
      const missing = state.scene === 'notconnected', initial = state.scene === 'initial';
      return send({ projectId, version: '1', revision: String(state.revision), serviceAvailable: !state.syncOff, syncEnabled: !state.syncOff,
        connection: missing ? 'not_connected' : state.scene === 'unavailable' ? 'unavailable' : state.scene === 'disconnected' ? 'disconnected' : 'connected',
        repository: missing ? null : { id: '10', fullName: 'codetreker/daynight', private: null },
        installation: missing ? null : { id: '20', accountLogin: 'codetreker' }, pollIntervalMinutes: 5, initializing: initial,
        poll: { running: initial, lastAttemptAt: missing ? null : at, lastSuccessAt: missing || initial ? null : at, nextAttemptAt: missing ? null : at,
          error: state.scene === 'stale' ? { code: 'remote_error', message: 'Temporary upstream failure', at } : null },
        webhook: { running: false, lastReceivedAt: missing ? null : at, lastAttemptAt: missing ? null : at, lastSuccessAt: missing ? null : at, error: null } });
    }
    if (path === `/api/v1/projects/${projectId}/pull-request-authors`) {
      state.authorReads.push(url.search);
      if (state.authorError) return send(fault(), 500);
      const query = url.searchParams.get('q') ?? '', cursor = url.searchParams.get('cursor');
      const parts = cursor === null ? null : cursor.split(':');
      if (parts !== null && Number(parts[2]) !== state.revision) return send(fault('resource_conflict'), 409);
      const offset = parts === null ? 0 : Number(parts[1]);
      const matches = authors.filter(author => author.login.toLowerCase().includes(query.toLowerCase()));
      return send({ projectId, revision: String(state.revision), items: matches.slice(offset, offset + 50), nextCursor: offset + 50 < matches.length ? `authors:${offset + 50}:${state.revision}` : null });
    }
    if (path === `/api/v1/projects/${projectId}/pull-requests`) {
      state.pageReads.push(url.search);
      if (state.scene === 'read-error') return send(fault(), 500);
      if (url.searchParams.get('limit') !== '6') throw new Error('The production list must request six summaries.');
      const filter = url.searchParams.get('state') ?? 'active', query = url.searchParams.get('q') ?? '', cursor = url.searchParams.get('cursor'), authorId = url.searchParams.get('authorId');
      let position = cursor === null ? { offset: 0, state: filter, query, authorId } : cursors.get(cursor);
      if (cursor !== null && position === undefined) {
        const anchor = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (anchor.v === (authorId === null ? 1 : 2) && (authorId === null || anchor.authorId === authorId) && anchor.projectId === projectId && anchor.state === filter && anchor.q === query && anchor.limit === 6 && anchor.direction === 'next' && BigInt(String(anchor.anchorNumber)) === BigInt(String(anchor.upperNumber)) + 1n) position = { offset: 0, state: filter, query, authorId };
      }
      if (!position || position.state !== filter || position.query !== query || position.authorId !== authorId) return send(fault('invalid_input'), 400);
      const available = !['empty', 'notconnected', 'initial'].includes(state.scene), all = available ? records : [];
      const scoped = all.filter(item => authorId === null || item.author?.id === authorId);
      const matches = scoped.filter(item => (filter === 'all' || (filter === 'active' ? item.state === 'open' : item.state === filter)) && `${item.title} ${item.number}`.toLowerCase().includes(query.toLowerCase().replace(/^#/, '')));
      const token = (offset: number) => { const key = `opaque:${filter}:${encodeURIComponent(query)}:${authorId}:${offset}`; cursors.set(key, { offset, state: filter, query, authorId }); return key; };
      const offset = position.offset;
      return send({ projectId, revision: String(state.revision), items: matches.slice(offset, offset + 6).map(item => ({ ...item, revision: String(state.revision), title: state.revision > 1 && item.number === '1248' ? `${item.title} updated` : item.title })), total: String(matches.length),
        counts: state.longCounts ? { active: '9223372036854775807', merged: '9223372036854775807', closed: '9223372036854775807', all: '9223372036854775807' } : { active: String(scoped.filter(item => item.state === 'open').length), merged: String(scoped.filter(item => item.state === 'merged').length), closed: String(scoped.filter(item => item.state === 'closed').length), all: String(scoped.length) }, ...(authorId === null ? {} : { authorId, projectTotal: String(all.length) }), previousCursor: offset > 0 ? token(Math.max(0, offset - 6)) : null, nextCursor: offset + 6 < matches.length ? token(offset + 6) : null });
    }
    if (path.startsWith(`/api/v1/projects/${projectId}/pull-requests/`)) {
      state.detailReads++;
      const item = records.find(item => path.endsWith(`/${item.number}`));
      if (!item) return send(fault('not_found'), 404);
      return send({ ...item, title: state.revision > 1 ? `${item.title} updated` : item.title, revision: String(state.revision), description });
    }
    state.unexpected.push(`${request.method()} ${path}`);
    return send(fault('not_found'), 404);
  });
  return state;
};
