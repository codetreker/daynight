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
  author: index === 4 ? null : { id: '42', login: 'author' }, state: index < 12 ? 'open' : index < 40 ? 'merged' : 'closed', draft: [2, 5, 9].includes(index),
  base: { repositoryId: '10', repositoryFullName: 'codetreker/daynight', ref: 'main' },
  head: { repositoryId: index === 4 ? null : '11', repositoryFullName: index === 4 ? null : 'international-platform-engineering/daynight-project-collaboration-runtime',
    ref: index === 4 ? null : 'fix/preserve-project-pr-description-and-stable-repository-identity-during-background-reconciliation', sha: '1234567890123456789012345678901234567890' },
  createdAt: at, updatedAt: at, closedAt: index < 12 ? null : at, mergedAt: index >= 12 && index < 40 ? at : null, observedAt: at, revision: '1',
}));

export const installPrList = async (page: Page) => {
  const task = detailFixture(projectId, '00000000-0000-4000-8000-000000000041', { title: 'Existing task' });
  const graph = graphFixture([task]);
  const state = { scene: 'populated' as Scene, revision: 1, graphFailure: false, pageReads: [] as string[], detailReads: 0, statusReads: 0, unexpected: [] as string[] };
  const cursors = new Map<string, { offset: number; state: string; query: string }>();
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
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
      return send({ projectId, version: '1', revision: String(state.revision), serviceAvailable: true,
        connection: missing ? 'not_connected' : state.scene === 'unavailable' ? 'unavailable' : state.scene === 'disconnected' ? 'disconnected' : 'connected',
        repository: missing ? null : { id: '10', fullName: 'codetreker/daynight', private: null },
        installation: missing ? null : { id: '20', accountLogin: 'codetreker' }, pollIntervalMinutes: 5, initializing: initial,
        poll: { running: initial, lastAttemptAt: missing ? null : at, lastSuccessAt: missing || initial ? null : at, nextAttemptAt: missing ? null : at,
          error: state.scene === 'stale' ? { code: 'remote_error', message: 'Temporary upstream failure', at } : null },
        webhook: { running: false, lastReceivedAt: missing ? null : at, lastAttemptAt: missing ? null : at, lastSuccessAt: missing ? null : at, error: null } });
    }
    if (path === `/api/v1/projects/${projectId}/pull-requests`) {
      state.pageReads.push(url.search);
      if (state.scene === 'read-error') return send(fault(), 500);
      if (url.searchParams.get('limit') !== '6') throw new Error('The production list must request six summaries.');
      const filter = url.searchParams.get('state') ?? 'active', query = url.searchParams.get('q') ?? '', cursor = url.searchParams.get('cursor');
      let position = cursor === null ? { offset: 0, state: filter, query } : cursors.get(cursor);
      if (cursor !== null && position === undefined) {
        const anchor = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (anchor.v === 1 && anchor.projectId === projectId && anchor.state === filter && anchor.q === query && anchor.limit === 6 && anchor.direction === 'next' && BigInt(String(anchor.anchorNumber)) === BigInt(String(anchor.upperNumber)) + 1n) position = { offset: 0, state: filter, query };
      }
      if (!position || position.state !== filter || position.query !== query) return send(fault('invalid_input'), 400);
      const available = !['empty', 'notconnected', 'initial'].includes(state.scene), all = available ? records : [];
      const matches = all.filter(item => (filter === 'all' || (filter === 'active' ? item.state === 'open' : item.state === filter)) && `${item.title} ${item.number}`.toLowerCase().includes(query.toLowerCase().replace(/^#/, '')));
      const token = (offset: number) => { const key = `opaque:${filter}:${encodeURIComponent(query)}:${offset}`; cursors.set(key, { offset, state: filter, query }); return key; };
      const offset = position.offset;
      return send({ projectId, revision: String(state.revision), items: matches.slice(offset, offset + 6).map(item => ({ ...item, revision: String(state.revision), title: state.revision > 1 && item.number === '1248' ? `${item.title} updated` : item.title })), total: String(matches.length),
        counts: { active: available ? '12' : '0', merged: available ? '28' : '0', closed: available ? '8' : '0', all: String(all.length) }, previousCursor: offset > 0 ? token(Math.max(0, offset - 6)) : null, nextCursor: offset + 6 < matches.length ? token(offset + 6) : null });
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
