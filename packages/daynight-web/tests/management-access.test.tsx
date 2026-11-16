import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MembersPanel } from '../src/features/management/MembersPanel';
import { pauseAuthRequests } from '../src/api/client';
import { ProjectSettingsPanel } from '../src/features/management/ProjectSettingsPanel';
import { ProjectAccessBoundary, useProjectAccess, type ProjectAccessSession } from '../src/features/projects/ProjectAccess';
import { useTaskGraph } from '../src/features/projects/useTaskGraph';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { renderWithLocale } from './helpers/renderWithLocale';
import { directAccessFixture, taskSyncFromGraph, taskSyncQuery, taskSyncResponse, TEST_VIEWER_ID } from './helpers/taskSync';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { saveDetail } from '../src/features/task-detail/detail-cache';
import { openDB } from 'idb';
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema } from '../src/features/task-cache/database';
import { wireResponse } from './helpers/wireJson';

const projectId = '10000000-0000-4000-8000-000000000001';
const root = `/api/v1/projects/${projectId}`;
const otherId = '20000000-0000-4000-8000-000000000002';
const stamp = '2026-10-23T10:00:00Z';
const user = { personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, id: TEST_VIEWER_ID, name: 'Alice', email: 'alice@example.test', emailVerified: true, avatarUrl: null };
const oldEmail = 'PRIVATE_OLD_ROSTER@example.test';
const freshEmail = 'CURRENT_ROSTER@example.test';
const roster = (email = oldEmail, role: "member" | "admin" = "member") => ({ actorAccess: directAccessFixture(projectId, TEST_VIEWER_ID, role), items: [
  { inheritedFrom: null, userId: TEST_VIEWER_ID, profile: { name: user.name, email: user.email, avatarUrl: null }, effectiveRole: 'member', directGrant: { projectId, userId: TEST_VIEWER_ID, role: 'member', version: 1n, createdAt: stamp, updatedAt: stamp } },
  { inheritedFrom: null, userId: otherId, profile: { name: 'Collaborator', email, avatarUrl: null }, effectiveRole: 'admin', directGrant: { projectId, userId: otherId, role: 'admin', version: 2n, createdAt: stamp, updatedAt: stamp } },
] });
const project = { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, id: projectId, name: 'Saved project', repoUrl: 'https://example.test/repo', createdAt: stamp, updatedAt: stamp, settings: { version: 3n, executionWarningMinutes: 60 } };
const json = (body: unknown, status = 200) => wireResponse(body, { status, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
const failure = (status: number) => json({ error: { code: status === 404 ? 'not_found' : 'internal_error', message: 'Failure', requestId: 'management-access' } }, status);
const mount = (kind: 'members' | 'settings', handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (kind === 'settings' && url === `/api/v1/me/projects/${projectId}/worker-prompt`) return json({ scope: 'project', scopeId: projectId, revision: '0', text: '', updatedAt: null });
    return kind === "members" && url === root ? json(project) : handler(url, init);
  });
  vi.stubGlobal('fetch', fetcher);
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: () => { void scope.invalidateScope(); } });
  let access!: ProjectAccessSession;
  const CaptureAccess = () => { access = useProjectAccess(projectId).session; return null; };
  const view = renderWithLocale(<ProjectAccessBoundary projectId={projectId}><CaptureAccess />{kind === 'members'
    ? <MembersPanel projectId={projectId} user={user} onRemoved={vi.fn()} onUnavailable={vi.fn()} />
    : <ProjectSettingsPanel projectId={projectId} user={user} />}</ProjectAccessBoundary>, { locale: 'en', taskCache: { scope } });
  return { view, scope, fetcher, access: () => access };
};
const focus = async (access: ProjectAccessSession) => { await act(async () => { fireEvent(window, new Event('focus')); await access.revalidate(); }); };

it.each([false, true])('rejects a held roster after confirmed denial, including recovery=%s', async (recover) => {
  let accessReads = 0;
  let rosterReads = 0;
  const held = Promise.withResolvers<Response>();
  const mounted = mount('members', (url) => {
    if (url === `${root}/access`) return ++accessReads === 2 ? failure(404) : json(directAccessFixture(projectId));
    if (url === `${root}/members`) return ++rosterReads === 1 ? held.promise : json(roster(freshEmail));
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    await waitFor(() => expect(mounted.access().snapshot()).toMatchObject({ status: 'ready', refreshing: false }));
    await focus(mounted.access());
    expect(mounted.access().snapshot().status).toBe('unavailable');
    expect(screen.queryByText(oldEmail)).toBeNull();
    if (recover) {
      await focus(mounted.access());
      await screen.findByText(freshEmail);
    }
    await act(async () => { held.resolve(json(roster())); await nextEventLoopTurn(); });
    expect(screen.queryByText(oldEmail)).toBeNull();
    if (recover) expect(screen.getByText(freshEmail)).toBeVisible();
    else expect(mounted.access().snapshot().status).toBe('unavailable');
  } finally { mounted.view.unmount(); mounted.scope.dispose(); }
});

it.each([
  { kind: 'settings', role: 'member' },
  { kind: 'members', role: 'member' },
  { kind: 'members', role: 'admin' },
] as const)('retains the successful $kind resource when access fails and recovers as $role', async ({ kind, role }) => {
  let accessReads = 0;
  let resourceReads = 0;
  let invitationReads = 0;
  const mounted = mount(kind, (url) => {
    if (url === `${root}/access`) return ++accessReads === 1 ? failure(503) : json(directAccessFixture(projectId, TEST_VIEWER_ID, role));
    if (url === (kind === 'members' ? `${root}/members` : root)) { resourceReads++; return json(kind === 'members' ? roster(oldEmail, role) : project); }
    if (url === `${root}/invitations`) { invitationReads++; return json({ items: [] }); }
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    if (kind === 'members') {
      await screen.findByText(oldEmail);
      expect(mounted.access().snapshot()).toMatchObject({ status: 'ready', access: { effectiveRole: role } });
    } else {
      await waitFor(() => expect(mounted.access().snapshot()).toMatchObject({ status: 'error', refreshing: false }));
      await waitFor(() => expect(screen.getAllByText('management-access').some(element => !element.closest('[hidden]'))).toBe(true));
      await focus(mounted.access());
    }
    expect(resourceReads).toBe(kind === 'settings' ? 2 : 1);
    if (kind === 'settings') expect(await screen.findByLabelText('Alert threshold')).toHaveValue(60);
    else await screen.findByText(oldEmail);
    await waitFor(() => kind === 'settings' ? expect(screen.queryAllByText('management-access').some(element => !element.closest('[hidden]'))).toBe(false) : expect(screen.queryByRole('alert')).toBeNull());
    if (kind === 'members' && role === 'admin') await waitFor(() => expect(invitationReads).toBeGreaterThan(0));
    else expect(resourceReads).toBe(kind === 'settings' ? 2 : 1);
  } finally { mounted.view.unmount(); mounted.scope.dispose(); }
});

it('invalidates revoked reads without cancelling an already submitted settings write', async () => {
  let allowed = true;
  let saved = project;
  let writes = 0;
  let writeSignal: AbortSignal | undefined;
  const heldWrite = Promise.withResolvers<Response>();
  const mounted = mount('settings', (url, init) => {
    if (url === `${root}/access`) return allowed ? json(directAccessFixture(projectId, TEST_VIEWER_ID, 'admin')) : failure(404);
    if (url === root) return json(saved);
    if (url === `${root}/settings` && init?.method === 'PATCH') { writes++; writeSignal = init.signal as AbortSignal; return heldWrite.promise; }
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    const field = await screen.findByLabelText('Alert threshold');
    await waitFor(() => expect(field).not.toBeDisabled());
    fireEvent.change(field, { target: { value: '90' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save settings' }).closest('form')!);
    await waitFor(() => expect(writes).toBe(1));
    allowed = false;
    await focus(mounted.access());
    expect(writeSignal!.aborted).toBe(false);
    expect(screen.queryByLabelText('Alert threshold')).toBeNull();
    saved = { ...project, settings: { version: 4n, executionWarningMinutes: 90 } };
    await act(async () => { heldWrite.resolve(json(saved)); await nextEventLoopTurn(); });
    allowed = true;
    await focus(mounted.access());
    await waitFor(() => expect(screen.getByLabelText('Alert threshold')).toHaveValue(90));
    expect(writes).toBe(1);
    expect(writeSignal!.aborted).toBe(false);
  } finally { mounted.view.unmount(); mounted.scope.dispose(); }
});

it('keeps an acknowledged settings write when an older recovery read arrives later', async () => {
  let allowed = true;
  let server = project;
  let resourceReads = 0;
  let writes = 0;
  const heldWrite = Promise.withResolvers<Response>();
  const heldResource = Promise.withResolvers<Response>();
  const mounted = mount('settings', (url, init) => {
    if (url === `${root}/access`) return allowed ? json(directAccessFixture(projectId, TEST_VIEWER_ID, 'admin')) : failure(404);
    if (url === root) return ++resourceReads === 2 ? heldResource.promise : json(server);
    if (url === `${root}/settings` && init?.method === 'PATCH') { writes++; return heldWrite.promise; }
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    const field = await screen.findByLabelText('Alert threshold');
    await waitFor(() => expect(field).not.toBeDisabled());
    fireEvent.change(field, { target: { value: '90' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save settings' }).closest('form')!);
    await waitFor(() => expect(writes).toBe(1));
    allowed = false;
    await focus(mounted.access());
    expect(screen.queryByLabelText('Alert threshold')).toBeNull();
    allowed = true;
    await focus(mounted.access());
    await waitFor(() => expect(resourceReads).toBe(2));
    await waitFor(() => expect(mounted.access().snapshot()).toMatchObject({ status: 'ready', refreshing: false }));
    server = { ...project, settings: { version: 4n, executionWarningMinutes: 90 } };
    await act(async () => { heldWrite.resolve(json(server)); await nextEventLoopTurn(); });
    await act(async () => { heldResource.resolve(json(project)); await nextEventLoopTurn(); });
    await waitFor(() => expect(screen.getByLabelText('Alert threshold')).toHaveValue(90));
    expect(screen.getByLabelText('Alert threshold')).not.toBeDisabled();
    expect(screen.getByText('Settings saved.')).toBeVisible();
    expect(writes).toBe(1);
  } finally { mounted.view.unmount(); mounted.scope.dispose(); }
});

it('retries an access-only failure without replacing a valid unsaved settings draft', async () => {
  let accessFails = false;
  let resourceReads = 0;
  let writes = 0;
  const mounted = mount('settings', (url, init) => {
    if (url === `${root}/access`) return accessFails ? failure(503) : json(directAccessFixture(projectId, TEST_VIEWER_ID, 'admin'));
    if (url === root) { resourceReads++; return json(project); }
    if (init?.method === 'PATCH') { writes++; throw new Error('The draft must not be submitted.'); }
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    const field = await screen.findByLabelText('Alert threshold');
    await waitFor(() => expect(field).not.toBeDisabled());
    fireEvent.change(field, { target: { value: '95' } });
    accessFails = true;
    await focus(mounted.access());
    expect(field).toHaveValue(95);
    expect(field).toBeDisabled();
    accessFails = false;
    const alert = screen.getAllByText('management-access').find(element => !element.closest('[hidden]'))!.closest('[role="alert"]') as HTMLElement;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mounted.access().snapshot()).toMatchObject({ status: 'ready', refreshing: false }));
    await waitFor(() => expect(screen.queryAllByText('management-access').some(element => !element.closest('[hidden]'))).toBe(false));
    expect(screen.getByLabelText('Alert threshold')).toHaveValue(95);
    expect(screen.getByLabelText('Alert threshold')).not.toBeDisabled();
    expect(resourceReads).toBe(1);
    expect(writes).toBe(0);
  } finally { mounted.view.unmount(); mounted.scope.dispose(); }
});

it.each([false, true])('keeps an acknowledged invitation and its full catalogue across older reads, post-ack read failure=%s', async (postAckReadFails) => {
  const existing = { id: '30000000-0000-4000-8000-000000000001', projectId, createdBy: TEST_VIEWER_ID, createdAt: stamp, expiresAt: '2099-10-30T10:00:00Z', consumedBy: null, consumedAt: null, revokedAt: null };
  const created = { ...existing, id: '30000000-0000-4000-8000-000000000002' };
  const link = new URL('/invitations#created-once', window.location.origin).href;
  let allowed = true;
  let committed = false;
  let invitationReads = 0;
  let writes = 0;
  let writeSignal: AbortSignal | undefined;
  const heldWrite = Promise.withResolvers<Response>();
  const heldInvitations = Promise.withResolvers<Response>();
  const mounted = mount('members', (url, init) => {
    if (url === `${root}/access`) return allowed ? json(directAccessFixture(projectId, TEST_VIEWER_ID, 'admin')) : failure(404);
    if (url === `${root}/members`) return json(roster(freshEmail, "admin"));
    if (url === `${root}/invitations` && init?.method === 'POST') { writes++; writeSignal = init.signal as AbortSignal; return heldWrite.promise; }
    if (url === `${root}/invitations`) {
      invitationReads++;
      if (invitationReads === 3) return heldInvitations.promise;
      if (invitationReads === 4 && postAckReadFails) return failure(503);
      return json({ items: committed ? [created, existing] : [existing] });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    await screen.findByRole('button', { name: `Revoke invitation ${existing.id}` });
    fireEvent.click(screen.getByRole('button', { name: 'Invite member' }));
    const confirm = screen.getByRole('button', { name: 'Create invitation link' });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(writes).toBe(1));
    allowed = false;
    await focus(mounted.access());
    allowed = true;
    await focus(mounted.access());
    await waitFor(() => expect(invitationReads).toBe(3));
    committed = true;
    await act(async () => { heldWrite.resolve(json({ ...created, link }, 201)); await nextEventLoopTurn(); });
    expect(await screen.findByLabelText('One-time invitation link')).toHaveValue(link);
    await act(async () => { heldInvitations.resolve(json({ items: [existing] })); await nextEventLoopTurn(); });
    fireEvent.click(screen.getByRole('button', { name: 'I have saved it, close' }));
    if (postAckReadFails) {
      fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    }
    await screen.findByRole('button', { name: `Revoke invitation ${created.id}` });
    expect(screen.getByRole('button', { name: `Revoke invitation ${existing.id}` })).toBeVisible();
    expect(screen.getByText(freshEmail)).toBeVisible();
    expect(screen.queryByLabelText('One-time invitation link')).toBeNull();
    expect(writes).toBe(1);
    expect(writeSignal!.aborted).toBe(false);
  } finally { mounted.view.unmount(); mounted.scope.dispose(); }
});

it('publishes the actorAccess from the members snapshot instead of mixing it with the earlier access read', async () => {
  const inherited = { ...directAccessFixture(projectId), effectiveRole: 'admin' as const, teamRole: 'admin' as const, canTransfer: true };
  const mounted = mount('members', (url) => {
    if (url === `${root}/access`) return json(directAccessFixture(projectId));
    if (url === `${root}/members`) return json({ ...roster(), actorAccess: inherited });
    if (url === `${root}/invitations`) return json({ items: [] });
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    await screen.findByText(oldEmail);
    expect(mounted.access().snapshot().access).toEqual(inherited);
    expect(screen.getByRole('button', { name: 'Invite member' })).toBeVisible();
  } finally { mounted.view.unmount(); mounted.scope.dispose(); }
});

it.each([false, true])('holds a members snapshot behind identity confirmation and rejects it after an identity change=%s', async (changed) => {
  const held = Promise.withResolvers<Response>();
  const mounted = mount('members', (url) => {
    if (url === `${root}/access`) return json(directAccessFixture(projectId));
    if (url === `${root}/members`) return held.promise;
    throw new Error(`Unexpected request ${url}`);
  });
  const { pauseAuthRequests } = await import('../src/api/client');
  let resume = () => {};
  try {
    await waitFor(() => expect(mounted.fetcher.mock.calls.some(([url]) => url.endsWith('/members'))).toBe(true));
    resume = pauseAuthRequests();
    await act(async () => { held.resolve(json(roster())); await nextEventLoopTurn(); });
    expect(screen.queryByText(oldEmail)).toBeNull();
    if (changed) await act(async () => { mounted.scope.principalMismatch(); });
    await act(async () => { resume(); await nextEventLoopTurn(); });
    if (changed) expect(screen.queryByText(oldEmail)).toBeNull();
    else expect(await screen.findByText(oldEmail)).toBeVisible();
  } finally { resume(); mounted.view.unmount(); mounted.scope.dispose(); }
});

it('rereads the whole members snapshot when a newer access observation supersedes its held first response', async () => {
  const held = Promise.withResolvers<Response>();
  let rosterReads = 0;
  const mounted = mount('members', (url) => {
    if (url === `${root}/access`) return json(directAccessFixture(projectId));
    if (url === `${root}/members`) return ++rosterReads === 1 ? held.promise : json(roster(freshEmail));
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    await waitFor(() => expect(rosterReads).toBe(1));
    await focus(mounted.access());
    await act(async () => { held.resolve(json(roster())); await nextEventLoopTurn(); });
    expect(await screen.findByText(freshEmail)).toBeVisible();
    expect(screen.queryByText(oldEmail)).toBeNull();
    expect(rosterReads).toBe(2);
  } finally { mounted.view.unmount(); mounted.scope.dispose(); }
});

it('marks a superseded grant reconciliation observed only after the replacement members read succeeds', async () => {
  const held = Promise.withResolvers<Response>();
  let rosterReads = 0;
  const mounted = mount('members', (url, init) => {
    if (url === `${root}/access`) return json(directAccessFixture(projectId, TEST_VIEWER_ID, 'admin'));
    if (url === `${root}/members`) return ++rosterReads === 3 ? held.promise : json(roster(freshEmail, 'admin'));
    if (url === `${root}/invitations`) return json({ items: [] });
    if (url === `${root}/grants/${otherId}` && init?.method === 'PUT') return failure(500);
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    const role = await screen.findByRole('combobox', { name: 'Direct grant for Collaborator' });
    await waitFor(() => expect(role).not.toBeDisabled());
    fireEvent.change(role, { target: { value: 'member' } });
    const confirm = screen.getByRole('button', { name: 'Save role' });
    await waitFor(() => expect(confirm).not.toBeDisabled());
    fireEvent.click(confirm);
    const read = await screen.findByRole('button', { name: 'Read current members' });
    fireEvent.click(read);
    await waitFor(() => expect(rosterReads).toBe(3));
    await focus(mounted.access());
    await act(async () => { held.resolve(json(roster(oldEmail, 'admin'))); await nextEventLoopTurn(); });
    await waitFor(() => expect(rosterReads).toBe(4));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Direct grant for Collaborator' })).not.toBeDisabled());
    expect(screen.queryByText(oldEmail)).toBeNull();
  } finally { mounted.view.unmount(); mounted.scope.dispose(); }
});


it('fences a peer snapshot created while self-removal is pending, then permits a fresh access recovery', async () => {
  class Channel {
    static peers = new Set<Channel>();
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor(readonly name: string) { Channel.peers.add(this); }
    postMessage(data: unknown) { for (const peer of Channel.peers) if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data } as MessageEvent<unknown>)); }
    close() { Channel.peers.delete(this); }
  }
  vi.stubGlobal('BroadcastChannel', Channel);
  const held = Promise.withResolvers<Response>();
  let removed = false;
  let deletes = 0;
  const mounted = mount('members', (url, init) => {
    if (url === `${root}/access`) return removed ? failure(404) : json(directAccessFixture(projectId, TEST_VIEWER_ID, 'admin'));
    if (url === `${root}/members`) return json(roster(oldEmail, 'admin'));
    if (url === `${root}/invitations`) return json({ items: [] });
    if (url === `${root}/grants/${TEST_VIEWER_ID}` && init?.method === 'DELETE') { deletes++; return held.promise; }
    throw new Error(`Unexpected request ${url}`);
  });
  const peer = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const signal = new AbortController().signal;
  const taskId = '30000000-0000-4000-8000-000000000001';
  const task = detailFixture(projectId, taskId, { description: 'private peer detail' });
  const sync = taskSyncFromGraph(graphFixture([task]), { versionForTask: () => task.version, propertiesForTask: () => task.properties });
  try {
    const button = await screen.findByRole('button', { name: 'Remove direct grant for Alice' });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    const confirm = screen.getByRole('button', { name: 'Remove grant' });
    await waitFor(() => expect(confirm).not.toBeDisabled()); fireEvent.click(confirm);
    await waitFor(() => expect(deletes).toBe(1));
    const before = await peer.beginSync(projectId, signal);
    const snapshot = await peer.applySync(before, sync, signal);
    expect(snapshot.project.manifest.cacheGeneration).not.toBe(before.cacheGeneration);
    const peerTicket = await peer.beginSync(projectId, signal);
    await saveDetail(peer, peerTicket, task, signal);
    expect(peer.getAuthorizedProject(projectId)).not.toBeNull();
    removed = true;
    await act(async () => { held.resolve(json({ projectId, userId: TEST_VIEWER_ID, deleted: true, actorAccess: null })); });
    await screen.findByText('Direct grant for Alice removed.');
    await waitFor(() => expect(peer.getAuthorizedProject(projectId)).toBeNull());
    const db = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
    try {
      await waitFor(async () => expect(await db.countFromIndex('summaries', 'by-project', [TEST_VIEWER_ID, projectId])).toBe(0));
      expect(await db.get('details', [TEST_VIEWER_ID, projectId, taskId])).toBeUndefined();
    } finally { db.close(); }
    expect(deletes).toBe(1);
    removed = false;
    await focus(mounted.access());
    await waitFor(() => expect(mounted.access().snapshot().status).toBe('ready'));
    expect(screen.getByText('Direct grant for Alice removed.')).toBeVisible();
    const fresh = await peer.beginSync(projectId, signal);
    expect(fresh.cacheGeneration).not.toBe(peerTicket.cacheGeneration);
    await peer.applySync(fresh, sync, signal);
    expect(peer.getAuthorizedProject(projectId)).not.toBeNull();
    expect(deletes).toBe(1);
  } finally { mounted.view.unmount(); mounted.scope.dispose(); peer.dispose(); }
});

it('keeps a confirmed self-removal receipt when access recovery fails and retries the read without repeating the write', async () => {
  const held = Promise.withResolvers<Response>();
  let phase: 'before' | 'offline' | 'restored' = 'before';
  const heldSync = Promise.withResolvers<Response>();
  let syncRequests = 0;
  let deletes = 0;
  const task = detailFixture(projectId, '30000000-0000-4000-8000-000000000001', { description: 'private cached detail' });
  const mounted = mount('members', (url, init) => {
    if (url === `${root}/access`) return phase === 'offline' ? failure(503) : json(directAccessFixture(projectId, TEST_VIEWER_ID, 'admin'));
    if (url.startsWith(`${root}/task-sync`)) { syncRequests++; return syncRequests === 1 ? heldSync.promise : taskSyncResponse(graphFixture([task]), { query: taskSyncQuery(new URL(url, location.origin)), versionForTask: () => task.version, propertiesForTask: () => task.properties, viewerId: TEST_VIEWER_ID }); }
    if (url === `${root}/members`) return json(roster(oldEmail, 'admin'));
    if (url === `${root}/invitations`) return json({ items: [] });
    if (url === `${root}/grants/${TEST_VIEWER_ID}` && init?.method === 'DELETE') { deletes++; return held.promise; }
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    const button = await screen.findByRole('button', { name: 'Remove direct grant for Alice' });
    await waitFor(() => expect(button).not.toBeDisabled()); fireEvent.click(button);
    const confirm = screen.getByRole('button', { name: 'Remove grant' });
    await waitFor(() => expect(confirm).not.toBeDisabled()); fireEvent.click(confirm);
    await waitFor(() => expect(deletes).toBe(1));
    const signal = new AbortController().signal;
    const ticket = await mounted.scope.beginSync(projectId, signal);
    await mounted.scope.applySync(ticket, taskSyncFromGraph(graphFixture([task]), { versionForTask: () => task.version, propertiesForTask: () => task.properties }), signal);
    expect(mounted.scope.getAuthorizedProject(projectId)).not.toBeNull();
    phase = 'offline';
    await act(async () => { held.resolve(json({ projectId, userId: TEST_VIEWER_ID, deleted: true, actorAccess: null })); });
    await screen.findByText('Direct grant for Alice removed.');
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText('Direct grant for Alice removed.')).toBeVisible();
    expect(mounted.access().snapshot().status).toBe('error');
    expect(mounted.scope.getAuthorizedProject(projectId)).toBeNull();
    expect(mounted.scope.canPreviewProject(projectId)).toBe(false);
    mounted.view.unmount();
    let graphAccess!: ProjectAccessSession;
    const GraphProbe = () => { graphAccess = useProjectAccess(projectId).session; const graph = useTaskGraph(projectId); return <div>{graph.snapshot?.graph.tasks.map((item) => item.titlePreview)}</div>; };
    const graphView = renderWithLocale(<ProjectAccessBoundary projectId={projectId} initialRead><GraphProbe /></ProjectAccessBoundary>, { locale: 'en', taskCache: { scope: mounted.scope } });
    try {
      await waitFor(() => expect(syncRequests).toBe(1));
      expect(screen.queryByText(task.title)).toBeNull();
      phase = 'restored';
      await focus(graphAccess);
      await screen.findByText(task.title);
      expect(syncRequests).toBe(2);
      await expect(mounted.scope.applySync(ticket, taskSyncFromGraph(graphFixture([task]), { versionForTask: () => task.version, propertiesForTask: () => task.properties }), signal)).rejects.toMatchObject({ name: 'AbortError' });
    } finally { graphView.unmount(); }
    expect(deletes).toBe(1);
  } finally { mounted.view.unmount(); mounted.scope.dispose(); }
});

it('withdraws shared project admission after a confirmed self-removal while the members panel is inactive', async () => {
  const heldWrite = Promise.withResolvers<Response>();
  const heldAccess = Promise.withResolvers<Response>();
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const removed = vi.fn();
  let deletes = 0;
  let accessReads = 0;
  let holdAccess = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === root) return json(project);
    if (url === `${root}/access`) { accessReads++; return holdAccess ? heldAccess.promise : json(directAccessFixture(projectId, TEST_VIEWER_ID, 'admin')); }
    if (url === `${root}/members`) return json(roster(oldEmail, 'admin'));
    if (url === `${root}/invitations`) return json({ items: [] });
    if (url === `${root}/grants/${TEST_VIEWER_ID}` && init?.method === 'DELETE') { deletes++; return heldWrite.promise; }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  let access!: ProjectAccessSession;
  const CaptureAccess = () => { access = useProjectAccess(projectId).session; return null; };
  const content = (active: boolean) => <ProjectAccessBoundary projectId={projectId}>
    <CaptureAccess />
    <input aria-label="Other draft" defaultValue="before" />
    <MembersPanel projectId={projectId} user={user} onRemoved={removed} active={active} onRoute={active} />
  </ProjectAccessBoundary>;
  const view = renderWithLocale(content(true), { locale: 'en', taskCache: { scope } });
  let resume = () => {};
  try {
    const button = await screen.findByRole('button', { name: 'Remove direct grant for Alice' });
    await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
    const confirm = screen.getByRole('button', { name: 'Remove grant' });
    await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
    await waitFor(() => expect(deletes).toBe(1));
    const signal = new AbortController().signal;
    const task = detailFixture(projectId, '30000000-0000-4000-8000-000000000001', { description: 'private cached detail' });
    const snapshot = taskSyncFromGraph(graphFixture([task]), { versionForTask: () => task.version, propertiesForTask: () => task.properties });
    const ticket = await scope.beginSync(projectId, signal);
    await scope.applySync(ticket, snapshot, signal);
    expect(scope.getAuthorizedProject(projectId)).not.toBeNull();
    view.rerender(content(false));
    fireEvent.change(screen.getByLabelText('Other draft'), { target: { value: 'new draft' } });
    const beforeReads = accessReads;
    holdAccess = true;
    resume = pauseAuthRequests();
    await act(async () => { heldWrite.resolve(json({ projectId, userId: TEST_VIEWER_ID, deleted: true, actorAccess: null })); await nextEventLoopTurn(); });
    expect(() => scope.getAuthorizedProject(projectId)).toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(scope.isProjectSuspended(projectId)).toBe(true);
    expect(accessReads).toBe(beforeReads);
    expect(screen.getByLabelText('Other draft')).toHaveValue('new draft');
    expect(removed).not.toHaveBeenCalled();
    resume();
    await waitFor(() => expect(accessReads).toBeGreaterThan(beforeReads));
    expect(scope.isProjectSuspended(projectId)).toBe(true);
    expect(scope.getAuthorizedProject(projectId)).toBeNull();
    expect(scope.canPreviewProject(projectId)).toBe(false);
    await act(async () => { heldAccess.resolve(failure(404)); await nextEventLoopTurn(); });
    await waitFor(() => expect(access.snapshot().status).toBe('unavailable'));
    expect(scope.getAuthorizedProject(projectId)).toBeNull();
    await expect(scope.applySync(ticket, snapshot, signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(screen.getByLabelText('Other draft')).toHaveValue('new draft');
    expect(removed).not.toHaveBeenCalled();
    expect(deletes).toBe(1);
    resume = pauseAuthRequests();
    const readsBeforeReturn = accessReads;
    view.rerender(content(true));
    await act(async () => { await nextEventLoopTurn(); });
    expect(screen.queryByText('Direct grant for Alice removed.')).toBeNull();
    expect(accessReads).toBe(readsBeforeReturn);
    expect(screen.getByLabelText('Other draft')).toHaveValue('new draft');
    resume();
    expect(await screen.findByText('Direct grant for Alice removed.')).toBeVisible();
    expect(screen.getByLabelText('Other draft')).toHaveValue('new draft');
    expect(removed).not.toHaveBeenCalled();
    expect(deletes).toBe(1);
  } finally { resume(); view.unmount(); scope.dispose(); }
});

it('holds a non-self grant receipt with lost actor access until shared access is restored', async () => {
  const heldWrite = Promise.withResolvers<Response>();
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const removed = vi.fn();
  let phase: 'initial' | 'offline' | 'restored' = 'initial';
  let writes = 0;
  let accessReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === root) return json(project);
    if (url === `${root}/access`) { accessReads++; return phase === 'offline' ? failure(503) : json(directAccessFixture(projectId, TEST_VIEWER_ID, 'admin')); }
    if (url === `${root}/members`) return json(roster(oldEmail, 'admin'));
    if (url === `${root}/invitations`) return json({ items: [] });
    if (url === `${root}/grants/${otherId}` && init?.method === 'DELETE') { writes++; return heldWrite.promise; }
    throw new Error(`Unexpected request ${url}`);
  }));
  let access!: ProjectAccessSession;
  const CaptureAccess = () => { access = useProjectAccess(projectId).session; return null; };
  const content = (active: boolean) => <ProjectAccessBoundary projectId={projectId}>
    <CaptureAccess />
    <input aria-label="Other draft" defaultValue="before" />
    <MembersPanel projectId={projectId} user={user} onRemoved={removed} active={active} onRoute={active} />
  </ProjectAccessBoundary>;
  const view = renderWithLocale(content(true), { locale: 'en', taskCache: { scope } });
  try {
    const button = await screen.findByRole('button', { name: 'Remove direct grant for Collaborator' });
    await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
    const confirm = screen.getByRole('button', { name: 'Remove grant' });
    await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
    await waitFor(() => expect(writes).toBe(1));
    const signal = new AbortController().signal;
    const task = detailFixture(projectId, '30000000-0000-4000-8000-000000000001');
    const snapshot = taskSyncFromGraph(graphFixture([task]), { versionForTask: () => task.version, propertiesForTask: () => task.properties });
    const ticket = await scope.beginSync(projectId, signal);
    await scope.applySync(ticket, snapshot, signal);
    expect(scope.getAuthorizedProject(projectId)).not.toBeNull();
    view.rerender(content(false));
    fireEvent.change(screen.getByLabelText('Other draft'), { target: { value: 'new draft' } });
    const beforeReads = accessReads;
    phase = 'offline';
    await act(async () => { heldWrite.resolve(json({ projectId, userId: otherId, deleted: true, actorAccess: null })); await nextEventLoopTurn(); });
    await waitFor(() => expect(accessReads).toBeGreaterThan(beforeReads));
    await waitFor(() => expect(access.snapshot().status).toBe('error'));
    expect(scope.getAuthorizedProject(projectId)).toBeNull();
    expect(scope.canPreviewProject(projectId)).toBe(false);
    expect(screen.queryByText('Direct grant for Collaborator removed.')).toBeNull();
    view.rerender(content(true));
    await act(async () => { await nextEventLoopTurn(); });
    expect(screen.queryByText('Direct grant for Collaborator removed.')).toBeNull();
    expect(screen.getByLabelText('Other draft')).toHaveValue('new draft');
    phase = 'restored';
    await focus(access);
    expect(await screen.findByText('Direct grant for Collaborator removed.')).toBeVisible();
    expect(screen.getByLabelText('Other draft')).toHaveValue('new draft');
    expect(removed).not.toHaveBeenCalled();
    expect(writes).toBe(1);
  } finally { view.unmount(); scope.dispose(); }
});

it('ignores a pre-receipt access response that arrives after the confirmed removal and fresh denial', async () => {
  const heldWrite = Promise.withResolvers<Response>();
  const heldAccess = Promise.withResolvers<Response>();
  let phase: 'initial' | 'held' | 'denied' = 'initial';
  let oldAccessRequested = false;
  let writes = 0;
  const mounted = mount('members', (url, init) => {
    if (url === `${root}/access`) {
      if (phase === 'held') { oldAccessRequested = true; return heldAccess.promise; }
      return phase === 'denied' ? failure(404) : json(directAccessFixture(projectId, TEST_VIEWER_ID, 'admin'));
    }
    if (url === `${root}/members`) return json(roster(oldEmail, 'admin'));
    if (url === `${root}/invitations`) return json({ items: [] });
    if (url === `${root}/grants/${TEST_VIEWER_ID}` && init?.method === 'DELETE') { writes++; return heldWrite.promise; }
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    const button = await screen.findByRole('button', { name: 'Remove direct grant for Alice' });
    await waitFor(() => expect(button).not.toBeDisabled()); fireEvent.click(button);
    const confirm = screen.getByRole('button', { name: 'Remove grant' });
    await waitFor(() => expect(confirm).not.toBeDisabled()); fireEvent.click(confirm);
    await waitFor(() => expect(writes).toBe(1));
    phase = 'held';
    let oldRead!: Promise<unknown>;
    act(() => { oldRead = mounted.access().revalidate(); });
    await waitFor(() => expect(oldAccessRequested).toBe(true));
    phase = 'denied';
    await act(async () => { heldWrite.resolve(json({ projectId, userId: TEST_VIEWER_ID, deleted: true, actorAccess: null })); });
    await screen.findByText('Direct grant for Alice removed.');
    await waitFor(() => expect(mounted.access().snapshot()).toMatchObject({ status: 'unavailable', access: null }));
    await act(async () => { heldAccess.resolve(json(directAccessFixture(projectId, TEST_VIEWER_ID, 'admin'))); await oldRead; });
    expect(mounted.access().snapshot()).toMatchObject({ status: 'unavailable', access: null });
    expect(screen.getByText('Direct grant for Alice removed.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove direct grant for Alice' })).toBeNull();
    expect(writes).toBe(1);
  } finally { mounted.view.unmount(); mounted.scope.dispose(); }
});

it('keeps the successful receipt and exposes cleanup failure and retry after removal', async () => {
  const heldWrite = Promise.withResolvers<Response>();
  let denied = false;
  let writes = 0;
  const mounted = mount('members', (url, init) => {
    if (url === `${root}/access`) return denied ? failure(404) : json(directAccessFixture(projectId, TEST_VIEWER_ID, 'admin'));
    if (url === `${root}/members`) return json(roster(oldEmail, 'admin'));
    if (url === `${root}/invitations`) return json({ items: [] });
    if (url === `${root}/grants/${TEST_VIEWER_ID}` && init?.method === 'DELETE') { writes++; return heldWrite.promise; }
    throw new Error(`Unexpected request ${url}`);
  });
  const errors: unknown[] = []; mounted.scope.subscribe((event) => { if (event.error !== undefined) errors.push(event.error); });
  try {
    const button = await screen.findByRole('button', { name: 'Remove direct grant for Alice' });
    await waitFor(() => expect(button).not.toBeDisabled()); fireEvent.click(button);
    const confirm = screen.getByRole('button', { name: 'Remove grant' });
    await waitFor(() => expect(confirm).not.toBeDisabled()); fireEvent.click(confirm);
    await waitFor(() => expect(writes).toBe(1));
    const signal = new AbortController().signal;
    const taskId = '30000000-0000-4000-8000-000000000001';
    const task = detailFixture(projectId, taskId, { description: 'private cached detail' });
    const ticket = await mounted.scope.beginSync(projectId, signal);
    await mounted.scope.applySync(ticket, taskSyncFromGraph(graphFixture([task]), { versionForTask: () => task.version, propertiesForTask: () => task.properties }), signal);
    await saveDetail(mounted.scope, await mounted.scope.beginSync(projectId, signal), task, signal);
    const original = IDBObjectStore.prototype.put;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'projects' && (args[0] as { state?: string }).state === 'invalidated') throw new DOMException('Injected purge failure', 'QuotaExceededError');
      return original.apply(this, args);
    });
    denied = true;
    await act(async () => { heldWrite.resolve(json({ projectId, userId: TEST_VIEWER_ID, deleted: true, actorAccess: null })); });
    await screen.findByText('Direct grant for Alice removed.');
    await waitFor(() => expect(errors).toContainEqual(expect.objectContaining({ category: 'storage' })));
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByText('Direct grant for Alice removed.')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('The operation could not be completed');
    const db = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
    try {
      expect(await db.get('details', [TEST_VIEWER_ID, projectId, taskId])).toBeDefined();
      fault.mockRestore(); fireEvent.click(retry);
      await waitFor(async () => expect(await db.get('details', [TEST_VIEWER_ID, projectId, taskId])).toBeUndefined());
      await waitFor(() => expect(mounted.access().snapshot().status).toBe('unavailable'));
    } finally { db.close(); }
    expect(screen.getByText('Direct grant for Alice removed.')).toBeVisible();
    expect(writes).toBe(1);
  } finally { mounted.view.unmount(); mounted.scope.dispose(); }
});


it('does not publish an initial settings resource or allow a save before replacement access is confirmed', async () => {
  const old = Promise.withResolvers<Response>(), fresh = Promise.withResolvers<Response>();
  let accessReads = 0, writes = 0;
  const mounted = mount('settings', (url, init) => {
    if (url === `${root}/access`) return ++accessReads === 1 ? old.promise : fresh.promise;
    if (url === root) return json(project);
    if (url === `${root}/settings` && init?.method === 'PATCH') { writes++; return json(project); }
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    await waitFor(() => expect(accessReads).toBe(1));
    const resume = pauseAuthRequests();
    fireEvent(window, new Event('focus'));
    await act(async () => old.resolve(json(directAccessFixture(projectId, TEST_VIEWER_ID, 'admin'))));
    expect(screen.queryByLabelText('Alert threshold')).toBeNull();
    resume();
    await waitFor(() => expect(accessReads).toBe(2));
    expect(screen.queryByLabelText('Alert threshold')).toBeNull();
    expect(writes).toBe(0);
    await act(async () => fresh.resolve(json(directAccessFixture(projectId, TEST_VIEWER_ID, 'member'))));
    const field = await screen.findByLabelText('Alert threshold');
    expect(field).toBeDisabled(); expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
    expect(writes).toBe(0);
  } finally { mounted.view.unmount(); mounted.scope.dispose(); }
});

it('publishes the trusted self-removal result outside the hidden members section after access loss', async () => {
  const heldWrite = Promise.withResolvers<Response>();
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const resultHost = document.createElement('div');
  document.body.append(resultHost);
  const removed = vi.fn();
  let denied = false;
  let writes = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === root) return json(project);
    if (url === `${root}/access`) return denied ? failure(404) : json(directAccessFixture(projectId, TEST_VIEWER_ID, 'admin'));
    if (url === `${root}/members`) return json(roster(oldEmail, 'admin'));
    if (url === `${root}/invitations`) return json({ items: [] });
    if (url === `${root}/grants/${TEST_VIEWER_ID}` && init?.method === 'DELETE') { writes++; return heldWrite.promise; }
    throw new Error(`Unexpected request ${url}`);
  }));
  const content = (active: boolean) => <ProjectAccessBoundary projectId={projectId}>
    <div hidden={!active} inert={!active}><MembersPanel projectId={projectId} projectName="Private project name" user={user} onRemoved={removed} active={active} onRoute resultHost={resultHost} presentationGeneration={active ? 0 : 1} /></div>
  </ProjectAccessBoundary>;
  const view = renderWithLocale(content(true), { locale: 'en', taskCache: { scope } });
  try {
    const button = await screen.findByRole('button', { name: 'Remove direct grant for Alice' });
    await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
    const confirm = screen.getByRole('button', { name: 'Remove grant' });
    await waitFor(() => expect(confirm).toBeEnabled()); fireEvent.click(confirm);
    await waitFor(() => expect(writes).toBe(1));
    view.rerender(content(false));
    denied = true;
    await act(async () => { heldWrite.resolve(json({ projectId, userId: TEST_VIEWER_ID, deleted: true, actorAccess: null })); });
    expect(scope.isProjectSuspended(projectId)).toBe(true);
    expect(await within(resultHost).findByText('Direct grant for Alice removed.')).toBeVisible();
    expect(within(resultHost).getByRole('button', { name: 'Return to projects' })).toBeVisible();
    expect(screen.queryByText('Private project name · Manage collaborators and invitations')).toBeNull();
    expect(screen.queryByText(oldEmail)).toBeNull();
    expect(removed).not.toHaveBeenCalled();
    fireEvent.click(within(resultHost).getByRole('button', { name: 'Return to projects' }));
    expect(removed).toHaveBeenCalledOnce();
    expect(writes).toBe(1);
  } finally { view.unmount(); scope.dispose(); resultHost.remove(); }
});
