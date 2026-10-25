import { wireResponse } from "../helpers/wireJson";
import { taskSyncQuery, taskSyncResponse } from "../helpers/taskSync";
import type { PersonalAccessToken, ProjectInvitation, ProjectMember, User } from '../../src/api/auth-types';
import type { Attachment, Project, TaskDetail, TaskGraph } from '../../src/api/types';
import { stringifyApiJson } from '../../src/api/json';
import { browsingProjects } from './browsing-fixture';
import previewHtml from '../../../../docs/design/mockups/auth/preview-assets/index.html?raw';
import previewCss from '../../../../docs/design/mockups/auth/preview-assets/style.css?raw';
import previewScript from '../../../../docs/design/mockups/auth/preview-assets/app.js?raw';
import previewData from '../../../../docs/design/mockups/auth/preview-assets/data.json?raw';

export const authScenarios = [
  ['projects', '项目 · 已登录'], ['logged-out', '登录 · 未登录'],
  ['session-loading', '登录 · 检查中'], ['session-error', '登录 · 检查失败'],
  ['session-expired', '登录 · 当前会话过期'], ['login-error', '登录 · 身份交接失败'],
  ['providers-loading', '登录方式 · 加载中'], ['providers-error', '登录方式 · 加载失败'],
  ['providers-empty', '登录方式 · 未配置'], ['projects-loading', '项目 · 加载中'],
  ['projects-empty', '项目 · 尚未加入'], ['projects-error', '项目 · 加载失败'],
  ['project-create-loading', '项目 · 创建请求未完成'],
  ['long-names', '项目与账户 · 长内容'], ['project', '项目 · 任务视图'],
  ['members-admin', '成员 · 管理员'], ['members-member', '成员 · 普通成员'],
  ['members-last-admin', '成员 · 最后一名管理员'], ['members-error', '成员 · 加载失败'],
  ['member-version-conflict', '成员 · 修改时角色版本冲突'], ['member-role-lost', '成员 · 修改时失去管理员权限'],
  ['account', '账户 · 个人资料'], ['tokens', '令牌 · 列表'], ['tokens-empty', '令牌 · 空列表'],
  ['tokens-loading', '令牌 · 加载中'], ['tokens-error', '令牌 · 加载失败'],
  ['token-create-error', '令牌 · 创建失败'], ['token-secret', '令牌 · 创建后显示一次'],
  ['clipboard-failure', '令牌与邀请 · 自动复制失败'],
  ['invitations-empty', '项目邀请 · 空列表'], ['invitation-create-error', '项目邀请 · 创建失败'],
  ['invite', '加入邀请 · 待确认'], ['invite-signed-out', '加入邀请 · 登录后确认'],
  ['invite-unavailable', '加入邀请 · 已失效'], ['invite-invalid', '加入邀请 · 缺少链接'],
  ['access-unavailable', '项目 · 无访问权限'], ['attachments', '附件 · 同源 HTML 预览'],
  ['attachment-head-unauthorized', '附件 · 预检时会话失效'],
] as const;
export type AuthScenario = typeof authScenarios[number][0];
export const readAuthScenario = (): AuthScenario => {
  const value = new URLSearchParams(location.search).get('scenario');
  return authScenarios.find(([id]) => id === value)?.[0] ?? 'projects';
};

const uuid = (number: number): string => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
export const authProjectId = browsingProjects.mixed.project.id;
export const authUserId = uuid(201);
const stamp = '2026-10-22T09:00:00Z';
const future = '2026-11-21T09:00:00Z';
const secret = 'auth_fixture_invitation_7kP3m9';
const currentUser: User = { id: authUserId, name: 'Jianjun', email: 'jianjun@example.com', emailVerified: true, avatarUrl: null };
type WireMember = Omit<ProjectMember, 'version'> & { version: number };
type StoredProject = { project: Project; graph: TaskGraph; epoch: string; members: WireMember[]; invitations: ProjectInvitation[] };
const member = (userId: string, name: string, email: string, role: WireMember['role'], projectId = authProjectId): WireMember => ({ projectId, userId, name, email, avatarUrl: null, role, version: 1, createdAt: stamp, updatedAt: stamp });
const emptySummary = { total: 0, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 };
const initialInvitation = (projectId: string, number: number): ProjectInvitation => ({ id: uuid(number), projectId, createdBy: authUserId, createdAt: stamp, expiresAt: '2026-10-29T09:00:00Z', consumedBy: null, consumedAt: null, revokedAt: null });
const error = (status: number, code: string): Response => Response.json({ error: { code, message: 'Controlled authentication fixture failure.', requestId: `auth-fixture-${code}` } }, { status });
const wait = (signal: AbortSignal | null | undefined): Promise<Response> => new Promise((_resolve, reject) => {
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});
const empty = (): Response => new Response(null, { status: 204 });
const tokenExpiry = (value: unknown): value is string | null => value === null || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now();

export const authPreviewAssets: Readonly<Record<string, { readonly contentType: string; readonly body: string }>> = {
  'site/index.html': { contentType: 'text/html', body: previewHtml },
  'site/style.css': { contentType: 'text/css', body: previewCss },
  'site/app.js': { contentType: 'text/javascript', body: previewScript },
  'site/data.json': { contentType: 'application/json', body: previewData },
};
const attachments: readonly Attachment[] = Object.entries(authPreviewAssets).map(([path, file]) => ({ path, contentType: file.contentType, sizeBytes: new TextEncoder().encode(file.body).length, createdAt: stamp, updatedAt: stamp }));

export const installAuthFixture = (initial: AuthScenario) => {
  const originalFetch = window.fetch;
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const originalClipboard = navigator.clipboard;
  let scenario = initial;
  let authenticated = true;
  let projects = new Map<string, StoredProject>();
  let tokens: PersonalAccessToken[] = [];
  let sequence = 500;
  let conflictApplied = false;
  let loginCompleted = false;
  let activeUser = currentUser;
  let identityPaused = false;
  const identityWaiters = new Set<{ readonly release: (response?: Response) => void; readonly cancel: () => void }>();
  const requests: { readonly method: string; readonly path: string }[] = [];

  const reset = (next: AuthScenario): void => {
    scenario = next; sequence = 500; conflictApplied = false; loginCompleted = false; requests.length = 0;
    for (const pending of identityWaiters) pending.cancel();
    identityPaused = false; activeUser = currentUser;
    authenticated = !['logged-out', 'login-error', 'providers-loading', 'providers-error', 'providers-empty', 'invite-signed-out'].includes(next);
    tokens = next === 'tokens-empty' ? [] : [
      { id: uuid(301), name: 'MacBook · 日常开发', createdAt: stamp, expiresAt: null },
      { id: uuid(302), name: '构建服务器 · 发布自动化', createdAt: stamp, expiresAt: future },
      { id: uuid(303), name: '旧开发环境', createdAt: '2026-09-18T09:00:00Z', expiresAt: '2026-10-18T09:00:00Z' },
    ];
    projects = new Map([browsingProjects.mixed, browsingProjects.external, browsingProjects.complete].map((source, index) => {
      const project: Project = { ...source.project, name: index === 0 ? next === 'long-names' ? '跨团队协作与自动化研发基础设施 · 国际化平台迁移及可观测性建设' : 'Daynight' : index === 1 ? 'Syntrix' : 'UniAuth' };
      const members = [member(authUserId, 'Jianjun', 'jianjun@example.com', next === 'members-member' ? 'member' : 'admin', project.id), member(uuid(202), 'Alice Chen', 'alice.chen@example.com', next === 'members-last-admin' ? 'member' : 'admin', project.id), member(uuid(203), 'Bob Wang', 'bob.wang@example.com', 'member', project.id)];
      return [project.id, { project, graph: { ...source, project }, epoch: crypto.randomUUID(), members, invitations: next === 'invitations-empty' ? [] : [initialInvitation(project.id, 401 + index)] }];
    }));
    if (next === 'projects-empty' || next === 'invite' || next === 'invite-signed-out') projects = new Map();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: next === 'clipboard-failure' ? { writeText: async () => { throw new DOMException('Controlled clipboard denial.', 'NotAllowedError'); } } : originalClipboard });
    sessionStorage.removeItem('daynight.pendingInvitation');
    const route = next.startsWith('members-') || next.startsWith('member-') || next === 'invitations-empty' || next === 'invitation-create-error'
      ? `/projects/${authProjectId}/members`
      : ['project', 'access-unavailable', 'attachments', 'attachment-head-unauthorized'].includes(next) ? `/projects/${authProjectId}`
        : next.startsWith('tokens') || next.startsWith('token-') || next === 'account' || next === 'clipboard-failure' ? '/account'
          : next.startsWith('invite') ? '/invitations' : '/';
    const fragment = route === '/invitations' && next !== 'invite-invalid' ? `#${secret}` : '';
    history.replaceState(null, '', `${route}${next === 'login-error' ? '?authError=login_failed' : ''}${fragment}`);
  };

  const routeFixture: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return originalFetch(input, init);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const signal = init?.signal ?? request?.signal;
    signal?.throwIfAborted();
    requests.push({ method, path: url.pathname });
    const body = async (): Promise<Record<string, unknown>> => JSON.parse(typeof init?.body === 'string' ? init.body : request === null ? '{}' : await request.clone().text()) as Record<string, unknown>;
    if (url.pathname === '/api/v1/auth/providers' && method === 'GET') {
      if (scenario === 'providers-loading' && !loginCompleted) return wait(signal);
      if (scenario === 'providers-error' && !loginCompleted) return error(500, 'internal_error');
      return Response.json({ providers: scenario === 'providers-empty' ? [] : ['microsoft', 'google', 'github'] });
    }
    if (url.pathname === '/api/v1/me' && method === 'GET') {
      if (scenario === 'session-loading') return wait(signal);
      if (scenario === 'session-error') return error(500, 'internal_error');
      if (!authenticated) return error(401, 'unauthenticated');
      if (identityPaused) return new Promise<Response>((resolve, reject) => {
        const finish = () => { identityWaiters.delete(pending); signal?.removeEventListener('abort', pending.cancel); };
        const pending = {
          release: (response?: Response) => { finish(); resolve(response ?? Response.json(activeUser)); },
          cancel: () => { finish(); reject(signal?.reason ?? new DOMException('Fixture identity check cancelled.', 'AbortError')); },
        };
        identityWaiters.add(pending); signal?.addEventListener('abort', pending.cancel, { once: true });
      });
      return Response.json(scenario === 'long-names' ? { ...activeUser, name: 'Jianjun · 国际化平台与自动化研发协作团队', email: 'development-collaboration-platform@example.com' } : activeUser);
    }
    if (url.pathname === '/api/v1/auth/logout' && method === 'POST') { authenticated = false; return empty(); }
    if (!authenticated) return error(401, 'unauthenticated');
    if (url.pathname === '/api/v1/me/tokens') {
      if (method === 'GET') {
        if (scenario === 'tokens-loading') return wait(signal);
        if (scenario === 'tokens-error') {
          const failure = error(500, 'internal_error'); failure.headers.set('Daynight-User-ID', activeUser.id); return failure;
        }
        return Response.json({ items: tokens }, { headers: { 'Daynight-User-ID': activeUser.id } });
      }
      if (method === 'POST') {
        if (scenario === 'token-create-error') return error(500, 'internal_error');
        const data = await body();
        if (typeof data.name !== 'string' || data.name.trim() === '' || [...data.name].length > 100 || !tokenExpiry(data.expiresAt)) return error(400, 'invalid_input');
        const token: PersonalAccessToken = { id: uuid(++sequence), name: data.name, createdAt: stamp, expiresAt: data.expiresAt };
        tokens = [token, ...tokens];
        return Response.json({ ...token, token: 'dn_auth_fixture_example_7pN4sK2mQ9xT6vR3hW8cA5yB1zF0' }, { status: 201 });
      }
    }
    const tokenMatch = /^\/api\/v1\/me\/tokens\/([^/]+)$/.exec(url.pathname);
    if (tokenMatch !== null && method === 'PATCH') {
      const data = await body();
      const refusal = (status: number, code: string) => Response.json({ error: { code, message: 'Controlled token expiration failure.', requestId: `auth-fixture-${code}` } }, { status, headers: { 'Daynight-User-ID': activeUser.id } });
      if (data.expectedUserId !== activeUser.id) return refusal(403, 'forbidden');
      if (!tokenExpiry(data.expiresAt)) return refusal(400, 'invalid_input');
      const token = tokens.find((entry) => entry.id === tokenMatch[1]);
      if (token === undefined || token.expiresAt !== null && Date.parse(token.expiresAt) <= Date.now()) return refusal(404, 'not_found');
      if (data.expectedExpiresAt !== token.expiresAt) return refusal(409, 'version_conflict');
      const updated: PersonalAccessToken = { ...token, expiresAt: data.expiresAt };
      tokens = tokens.map((entry) => entry.id === updated.id ? updated : entry);
      return Response.json(updated, { headers: { 'Daynight-User-ID': activeUser.id } });
    }
    if (tokenMatch !== null && method === 'DELETE') { tokens = tokens.filter((token) => token.id !== tokenMatch[1]); return empty(); }
    if (url.pathname === '/api/v1/projects') {
      if (method === 'GET') {
        if (scenario === 'session-expired' && !loginCompleted) { authenticated = false; return error(401, 'unauthenticated'); }
        if (scenario === 'projects-loading') return wait(signal);
        if (scenario === 'projects-error') return error(500, 'internal_error');
        return wireResponse({ items: [...projects.values()].map((entry) => entry.project), nextCursor: null });
      }
      if (method === 'POST') {
        if (scenario === 'project-create-loading') return wait(signal);
        const data = await body();
        if (typeof data.name !== 'string' || data.name.trim() === '' || typeof data.repoUrl !== 'string' || data.repoUrl.trim() === '') return error(400, 'invalid_input');
        const project: Project = { settings: { version: 1n, executionWarningMinutes: 60 }, id: uuid(++sequence), name: data.name, repoUrl: data.repoUrl, createdAt: stamp, updatedAt: stamp };
        projects.set(project.id, { project, graph: { observedAt: "2026-10-20T12:00:00Z", project, summary: emptySummary, tasks: [] }, epoch: crypto.randomUUID(), members: [member(authUserId, currentUser.name!, currentUser.email!, 'admin', project.id)], invitations: [] });
        return wireResponse(project, { status: 201 });
      }
    }
    if (url.pathname === '/api/v1/invitations/inspect' || url.pathname === '/api/v1/invitations/accept') {
      const data = await body();
      if (data.token !== secret || scenario === 'invite-unavailable') return error(410, 'invitation_unavailable');
      if (method !== 'POST') return error(405, 'method_not_allowed');
      if (url.pathname.endsWith('/inspect')) {
        const existing = projects.get(authProjectId)?.members.find((item) => item.userId === authUserId);
        return Response.json({ projectId: authProjectId, projectName: 'Daynight', ...(existing === undefined ? {} : { member: existing }) });
      }
      const joined = member(authUserId, currentUser.name!, currentUser.email!, 'member');
      const graph = browsingProjects.mixed;
      projects.set(authProjectId, { project: { ...graph.project, name: 'Daynight' }, graph: { ...graph, project: { ...graph.project, name: 'Daynight' } }, epoch: crypto.randomUUID(), members: [joined, member(uuid(202), 'Alice Chen', 'alice.chen@example.com', 'admin')], invitations: [] });
      return Response.json(joined);
    }
    const scoped = /^\/api\/v1\/projects\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    const entry = scoped === null ? undefined : projects.get(scoped[1]!);
    if (entry !== undefined && scoped !== null) {
      const suffix = scoped[2] ?? '';
      if (scenario === 'access-unavailable') return error(404, 'not_found');
      const current = entry.members.find((item) => item.userId === activeUser.id);
      if (current === undefined) return error(404, 'not_found');
      if (suffix === '' && method === 'GET') return wireResponse(entry.project);
      if (suffix === 'task-graph' && method === 'GET') return wireResponse(entry.graph);
      if (suffix === 'task-sync' && method === 'GET') return taskSyncResponse(entry.graph, { query: taskSyncQuery(url), epoch: entry.epoch, versionForTask: () => 1n, viewerId: activeUser.id });
      if (suffix === 'members' && method === 'GET') {
        if (scenario === 'members-error') return error(500, 'internal_error');
        return Response.json({ items: entry.members });
      }
      const memberMatch = /^members\/([^/]+)$/.exec(suffix);
      if (memberMatch !== null && (method === 'PATCH' || method === 'DELETE')) {
        if (current.role !== 'admin') return error(403, 'forbidden');
        if (!conflictApplied && (scenario === 'member-version-conflict' || scenario === 'member-role-lost')) {
          conflictApplied = true;
          entry.members = entry.members.map((item) => item.userId === authUserId ? { ...item, role: 'member', version: item.version + 1 } : item);
          return error(scenario === 'member-version-conflict' ? 409 : 403, scenario === 'member-version-conflict' ? 'version_conflict' : 'forbidden');
        }
        const data = await body();
        const target = entry.members.find((item) => item.userId === memberMatch[1]);
        if (target === undefined) return error(404, 'not_found');
        if (data.version !== target.version) return error(409, 'version_conflict');
        if (target.role === 'admin' && entry.members.filter((item) => item.role === 'admin').length === 1 && (method === 'DELETE' || data.role === 'member')) return error(409, 'last_admin');
        if (method === 'DELETE') { entry.members = entry.members.filter((item) => item !== target); if (target.userId === authUserId) projects.delete(entry.project.id); return empty(); }
        const changed: WireMember = { ...target, role: data.role === 'admin' ? 'admin' : 'member', version: target.version + 1, updatedAt: stamp };
        entry.members = entry.members.map((item) => item === target ? changed : item);
        return Response.json(changed);
      }
      if (suffix === 'invitations') {
        if (current.role !== 'admin') return error(403, 'forbidden');
        if (method === 'GET') return Response.json({ items: entry.invitations });
        if (method === 'POST') {
          if (scenario === 'invitation-create-error') return error(500, 'internal_error');
          const invitation = initialInvitation(entry.project.id, ++sequence);
          entry.invitations = [invitation, ...entry.invitations];
          return Response.json({ ...invitation, link: `${location.origin}/invitations#${secret}` }, { status: 201 });
        }
      }
      const invitationMatch = /^invitations\/([^/]+)$/.exec(suffix);
      if (invitationMatch !== null && method === 'DELETE') { if (current.role !== 'admin') return error(403, 'forbidden'); entry.invitations = entry.invitations.filter((item) => item.id !== invitationMatch[1]); return empty(); }
      const taskMatch = /^tasks\/([^/]+)(?:\/(.*))?$/.exec(suffix);
      if (taskMatch !== null) {
        const task = entry.graph.tasks.find((item) => item.id === taskMatch[1]);
        if (task === undefined) return error(404, 'not_found');
        const taskSuffix = taskMatch[2] ?? '';
        if (taskSuffix === '' && method === 'GET') {
          const detail: TaskDetail = { requiredPlatform: task.requiredPlatform, allowAgents: task.allowAgents, startedAt: task.startedAt, completedAt: task.completedAt, id: task.id, projectId: entry.project.id, title: task.titlePreview, description: '完成项目范围内的实现与验证，确认成员权限、任务状态与实际交付结果一致。', properties: { worker: null, pullRequests: [] }, status: task.status, version: 1n, dependsOn: task.dependsOn, externalDependsOn: task.externalDependsOn, blockedBy: task.blockedBy, ready: task.ready, createdAt: task.createdAt, updatedAt: task.updatedAt };
          return new Response(stringifyApiJson(detail), { headers: { 'Content-Type': 'application/json' } });
        }
        if (taskSuffix === 'attachments' && method === 'GET') return Response.json({ items: attachments, nextCursor: null });
        const fileMatch = /^(preview|attachments\/files)\/(.+)$/.exec(taskSuffix);
        if (fileMatch !== null) {
          if (scenario === 'attachment-head-unauthorized') {
            authenticated = false;
            return method === 'HEAD' ? new Response(null, { status: 401, headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'auth-fixture-expired' } }) : error(401, 'unauthenticated');
          }
          const file = authPreviewAssets[decodeURIComponent(fileMatch[2]!)];
          if (file === undefined) return error(404, 'not_found');
          if (method === 'HEAD') return new Response(null, { headers: { 'Content-Type': file.contentType } });
          if (method === 'GET') return new Response(file.body, { headers: { 'Content-Type': file.contentType } });
        }
      }
    }
    if (scoped !== null) return error(404, 'not_found');
    throw new Error(`Unhandled authentication fixture request: ${method} ${url.pathname}`);
  };
  const fetchFixture: typeof fetch = async (input, init) => {
    const response = await routeFixture(input, init);
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (authenticated && response.status !== 401 && url.origin === location.origin && url.pathname.startsWith('/api/v1/') && !url.pathname.startsWith('/api/v1/auth/')) response.headers.set('Daynight-User-ID', activeUser.id);
    return response;
  };
  const keepFixtureHome = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>('a[href]');
    if (link === null || link.origin !== location.origin || link.pathname !== '/' || link.search !== '' || link.hash !== '' || link.target !== '') return;
    event.preventDefault();
    history.pushState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  window.fetch = fetchFixture;
  document.addEventListener('click', keepFixtureHome);
  reset(initial);
  return {
    reset,
    requests,
    pauseIdentityChecks: () => { identityPaused = true; },
    resumeIdentityChecks: () => { identityPaused = false; for (const pending of identityWaiters) pending.release(); },
    failIdentityChecks: () => { identityPaused = false; for (const pending of identityWaiters) pending.release(error(503, 'internal_error')); },
    expireIdentityChecks: () => { authenticated = false; identityPaused = false; for (const pending of identityWaiters) pending.release(error(401, 'unauthenticated')); },
    switchToAlice: () => { activeUser = { ...currentUser, id: uuid(202), name: 'Alice Chen', email: 'alice.chen@example.com' }; tokens = []; },
    completeLogin: (url: string) => {
      const login = new URL(url, location.origin);
      if (login.pathname !== '/api/v1/auth/login') throw new Error('The fixture only handles Daynight login redirects.');
      authenticated = true; loginCompleted = true;
      history.replaceState(null, '', login.searchParams.get('returnPath') ?? '/');
    },
    dispose: () => {
      for (const pending of identityWaiters) pending.cancel();
      document.removeEventListener('click', keepFixtureHome);
      if (window.fetch === fetchFixture) window.fetch = originalFetch;
      if (clipboardDescriptor === undefined) delete (navigator as unknown as Record<string, unknown>).clipboard;
      else Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    },
  };
};
