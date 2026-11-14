// GitHub settings has independent route and mutation coverage.
vi.mock('../src/features/github-integration/GitHubSettings', () => ({ GitHubSettings: () => null }));

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AuthenticatedApp } from '../src/app/AuthenticatedApp';
import { navigate } from '../src/app/router';
import { TaskCacheScope } from '../src/features/task-cache/project-cache';
import { createLocaleRender } from './helpers/renderWithLocale';
import { personalTeamPage } from './helpers/team';
import { directAccessFixture, viewerHeaders } from './helpers/taskSync';
import { stringifyWireJson } from './helpers/wireJson';

const userId = '00000000-0000-4000-8000-000000000001';
const projectId = '00000000-0000-4000-8000-000000000003';
const otherId = '00000000-0000-4000-8000-000000000002';
const teamId = '00000000-0000-4000-8000-000000000701';
const invitationId = '00000000-0000-4000-8000-000000000020';
const stamp = '2026-10-22T10:00:00Z';
const user = { id: userId, name: 'Alice', email: 'alice@example.test', emailVerified: true, avatarUrl: null, personalTeam: { id: teamId, kind: 'personal' as const, name: null } };
const project = { id: projectId, name: 'Private project', repoUrl: 'https://github.com/example/repo', createdAt: stamp, updatedAt: stamp, ownership: { teamId, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 } };
const access = directAccessFixture(projectId, userId, 'admin');
const roster = { actorAccess: access, items: [{ userId, profile: { name: user.name, email: user.email, avatarUrl: null }, effectiveRole: 'admin', inheritedFrom: null, directGrant: { projectId, userId, role: 'admin', version: 1n, createdAt: stamp, updatedAt: stamp } }, { userId: otherId, profile: { name: 'Private collaborator', email: 'collaborator@example.test', avatarUrl: null }, effectiveRole: 'member', inheritedFrom: null, directGrant: { projectId, userId: otherId, role: 'member', version: 1n, createdAt: stamp, updatedAt: stamp } }] };
const invitation = { id: invitationId, projectId, createdBy: userId, createdAt: stamp, expiresAt: '2099-10-29T10:00:00Z', consumedBy: null, consumedAt: null, revokedAt: null, link: `${window.location.origin}/invitations#once-secret` };
const json = (body: unknown, status = 200) => new Response(stringifyWireJson(body), { status, headers: viewerHeaders(userId, { 'Content-Type': 'application/json' }) });
const unavailable = () => json({ error: { code: 'not_found', message: 'not found', requestId: 'denied-project' } }, 404);
const render = createLocaleRender('en');

beforeEach(() => {
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.replaceState(null, '', `/projects/${projectId}/settings?tab=members`);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});

const setup = () => {
  const write = Promise.withResolvers<Response>();
  let denyProject = false;
  let denyAccess = false;
  const fetcher = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
    if (url === '/api/v1/me') return Promise.resolve(json(user));
    if (url.startsWith('/api/v1/teams?')) return Promise.resolve(json(personalTeamPage(userId)));
    if (url === `/api/v1/teams/${teamId}`) return Promise.resolve(json(personalTeamPage(userId).items[0]));
    if (url.startsWith('/api/v1/projects?')) return Promise.resolve(json({ items: denyProject ? [] : [project], nextCursor: null }));
    if (url === `/api/v1/projects/${projectId}`) return Promise.resolve(denyProject ? unavailable() : json(project));
    if (url === `/api/v1/projects/${projectId}/access`) return Promise.resolve(denyAccess ? unavailable() : json(access));
    if (url === `/api/v1/projects/${projectId}/members`) return Promise.resolve(json(roster));
    if (url === `/api/v1/projects/${projectId}/invitations` && init?.method === 'POST') return Promise.resolve(json(invitation, 201));
    if (url === `/api/v1/projects/${projectId}/invitations`) return Promise.resolve(json({ items: [] }));
    if ((url === `/api/v1/projects/${projectId}/grants/${userId}` || url === `/api/v1/projects/${projectId}/grants/${otherId}`) && init?.method === 'DELETE') return write.promise;
    if (url === `/api/v1/me/projects/${projectId}/worker-prompt`) return Promise.resolve(json({ scope: 'project', scopeId: projectId, revision: '0', text: '', updatedAt: null }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const view = render(<AuthenticatedApp />);
  return { view, write, fetcher, denyProject: () => { denyProject = true; }, denyAccess: () => { denyAccess = true; } };
};

it('retains a revealed invitation when leaving settings and returning through the legacy members URL', async () => {
  const app = setup();
  const invite = await screen.findByRole('button', { name: 'Invite member' });
  await waitFor(() => expect(invite).toBeEnabled()); fireEvent.click(invite);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create invitation link' }));
  const field = await screen.findByDisplayValue(invitation.link);
  expect(field).toBeVisible();
  act(() => navigate('/projects'));
  expect(field).not.toBeVisible();
  act(() => navigate(`/projects/${projectId}/members`));
  expect(await screen.findByDisplayValue(invitation.link)).toBe(field);
  expect(field).toBeVisible();
  expect(app.fetcher.mock.calls.filter(([url, init]) => url.endsWith('/invitations') && init?.method === 'POST')).toHaveLength(1);
});

it('keeps the self-removal receipt visible outside the unavailable settings wrapper', async () => {
  const app = setup();
  const remove = await screen.findByRole('button', { name: 'Remove direct grant for Alice' });
  await waitFor(() => expect(remove).toBeEnabled()); fireEvent.click(remove);
  const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove grant' });
  await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
  await waitFor(() => expect(app.fetcher.mock.calls.some(([url, init]) => url.endsWith(`/grants/${userId}`) && init?.method === 'DELETE')).toBe(true));
  act(() => navigate('/projects'));
  app.denyProject();
  act(() => navigate(`/projects/${projectId}/settings?tab=execution`));
  await screen.findByText('Project not found or access unavailable.');
  app.denyAccess();
  await act(async () => app.write.resolve(json({ projectId, userId, deleted: true, actorAccess: null })));
  expect(await screen.findByText('Direct grant for Alice removed.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Return to projects' })).toBeVisible();
  expect(screen.queryByText('Private project')).toBeNull();
  expect(screen.queryByText(user.email)).toBeNull();
});


it.each(['lost', 'retained'] as const)('keeps a safe confirmed waiting notice after a different grant receipt with %s actor access and a project 404', async (actorAccess) => {
  const app = setup();
  const remove = await screen.findByRole('button', { name: 'Remove direct grant for Private collaborator' });
  await waitFor(() => expect(remove).toBeEnabled()); fireEvent.click(remove);
  const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove grant' });
  await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
  await waitFor(() => expect(app.fetcher.mock.calls.some(([url, init]) => url.endsWith(`/grants/${otherId}`) && init?.method === 'DELETE')).toBe(true));
  act(() => navigate('/projects'));
  app.denyProject();
  const accessReply = Promise.withResolvers<Response>();
  const accessRequested = vi.fn();
  const fetch = app.fetcher.getMockImplementation()!;
  app.fetcher.mockImplementation((url, init) => {
    if (url === `/api/v1/projects/${projectId}/access`) {
      accessRequested();
      return accessReply.promise.then(response => response.clone());
    }
    return fetch(url, init);
  });
  act(() => navigate(`/projects/${projectId}/settings?tab=execution`));
  await screen.findByText('Project not found or access unavailable.');
  await waitFor(() => expect(accessRequested).toHaveBeenCalled());
  const expectHiddenCollaborator = () => {
    const email = screen.getByText('collaborator@example.test');
    const person = email.closest('.person');
    expect(person).not.toBeNull();
    expect(within(person as HTMLElement).getByText('Private collaborator')).not.toBeVisible();
    expect(email).not.toBeVisible();
    expect(email.closest('[hidden]')).not.toBeNull();
    expect(email.closest('[inert]')).not.toBeNull();
  };
  expectHiddenCollaborator();
  const expectCollaboratorRemoved = () => {
    expect(screen.queryByText('Private collaborator')).toBeNull();
    expect(screen.queryByText('collaborator@example.test')).toBeNull();
  };

  const revoked = vi.fn();
  const observeRevocation = (scope: TaskCacheScope) => {
    const unsubscribe = scope.subscribe(event => {
      if (event.projectId !== projectId || !event.accessRevoked) return;
      unsubscribe(); revoked();
    });
  };
  if (actorAccess === 'lost') {
    const suspend = TaskCacheScope.prototype.suspendProject;
    vi.spyOn(TaskCacheScope.prototype, 'suspendProject').mockImplementation(function (this: TaskCacheScope, id) {
      observeRevocation(this); return suspend.call(this, id);
    });
  } else {
    const revoke = TaskCacheScope.prototype.revokeProject;
    vi.spyOn(TaskCacheScope.prototype, 'revokeProject').mockImplementation(function (this: TaskCacheScope, ...args) {
      observeRevocation(this); return revoke.apply(this, args);
    });
  }
  app.denyAccess();
  accessRequested.mockClear();
  await act(async () => app.write.resolve(json({ projectId, userId: otherId, deleted: true, actorAccess: actorAccess === 'lost' ? null : access })));
  expect(await screen.findByText('The change was confirmed; its details are available after access is verified.')).toBeVisible();
  expect(screen.queryByText('Direct grant for Private collaborator removed.')).toBeNull();
  if (actorAccess === 'lost') {
    await waitFor(() => expect(revoked).toHaveBeenCalled());
    await waitFor(expectCollaboratorRemoved);
  } else {
    await waitFor(() => expect(accessRequested).toHaveBeenCalled());
    expectHiddenCollaborator();
  }
  await act(async () => accessReply.resolve(unavailable()));
  await waitFor(() => expect(revoked).toHaveBeenCalled());
  await waitFor(expectCollaboratorRemoved);
  expect(screen.queryByText('Direct grant for Private collaborator removed.')).toBeNull();
  expect(screen.getByText('The change was confirmed; its details are available after access is verified.')).toBeVisible();
});
