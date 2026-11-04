import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MembersPanel } from '../src/features/management/MembersPanel';
import { ProjectSettingsPanel } from '../src/features/management/ProjectSettingsPanel';
import { ProjectAccessBoundary, useProjectAccess, type ProjectAccessSession } from '../src/features/projects/ProjectAccess';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { renderWithLocale } from './helpers/renderWithLocale';
import { directAccessFixture, TEST_VIEWER_ID } from './helpers/taskSync';
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
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', fetcher);
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  let access!: ProjectAccessSession;
  const CaptureAccess = () => { access = useProjectAccess(projectId).session; return null; };
  const view = renderWithLocale(<ProjectAccessBoundary projectId={projectId}><CaptureAccess />{kind === 'members'
    ? <MembersPanel projectId={projectId} projectName="Private directory" user={user} onRemoved={vi.fn()} onUnavailable={vi.fn()} />
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
      await screen.findByRole('alert');
      await focus(mounted.access());
    }
    expect(resourceReads).toBe(1);
    if (kind === 'settings') expect(await screen.findByLabelText('Alert threshold')).toHaveValue(60);
    else await screen.findByText(oldEmail);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    if (kind === 'members' && role === 'admin') await waitFor(() => expect(invitationReads).toBeGreaterThan(0));
    else expect(resourceReads).toBe(1);
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
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mounted.access().snapshot()).toMatchObject({ status: 'ready', refreshing: false }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
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
      if (invitationReads === 2) return heldInvitations.promise;
      if (invitationReads === 3 && postAckReadFails) return failure(503);
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
    await waitFor(() => expect(invitationReads).toBe(2));
    committed = true;
    await act(async () => { heldWrite.resolve(json({ ...created, link }, 201)); await nextEventLoopTurn(); });
    expect(await screen.findByLabelText('One-time invitation link')).toHaveValue(link);
    await act(async () => { heldInvitations.resolve(json({ items: [existing] })); await nextEventLoopTurn(); });
    fireEvent.click(screen.getByRole('button', { name: 'I have saved it, close' }));
    if (postAckReadFails) {
      await screen.findByRole('alert');
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
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
    if (url === `${root}/members`) return ++rosterReads === 2 ? held.promise : json(roster(freshEmail, 'admin'));
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
    await waitFor(() => expect(rosterReads).toBe(2));
    await focus(mounted.access());
    await act(async () => { held.resolve(json(roster(oldEmail, 'admin'))); await nextEventLoopTurn(); });
    await waitFor(() => expect(rosterReads).toBe(3));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Direct grant for Collaborator' })).not.toBeDisabled());
    expect(screen.queryByText(oldEmail)).toBeNull();
  } finally { mounted.view.unmount(); mounted.scope.dispose(); }
});
