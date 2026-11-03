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
const user = { id: TEST_VIEWER_ID, name: 'Alice', email: 'alice@example.test', emailVerified: true, avatarUrl: null };
const oldEmail = 'PRIVATE_OLD_ROSTER@example.test';
const freshEmail = 'CURRENT_ROSTER@example.test';
const roster = (email = oldEmail) => ({ items: [
  { projectId, userId: TEST_VIEWER_ID, name: user.name, email: user.email, avatarUrl: null, role: 'member', version: 1n, createdAt: stamp, updatedAt: stamp },
  { projectId, userId: otherId, name: 'Collaborator', email, avatarUrl: null, role: 'admin', version: 2n, createdAt: stamp, updatedAt: stamp },
] });
const project = { id: projectId, name: 'Saved project', repoUrl: 'https://example.test/repo', createdAt: stamp, updatedAt: stamp, settings: { version: 3n, executionWarningMinutes: 60 } };
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
    if (url === (kind === 'members' ? `${root}/members` : root)) { resourceReads++; return json(kind === 'members' ? roster() : project); }
    if (url === `${root}/invitations`) { invitationReads++; return json({ items: [] }); }
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    await waitFor(() => expect(mounted.access().snapshot()).toMatchObject({ status: 'error', refreshing: false }));
    await screen.findByRole('alert');
    expect(resourceReads).toBe(1);
    await focus(mounted.access());
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
