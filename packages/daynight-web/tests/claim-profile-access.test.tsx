import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRole } from '../src/api/auth-types';
import type { WorkerClaim } from '../src/api/types';
import { ProjectAccessBoundary, useProjectAccess, type ProjectAccessSession } from '../src/features/projects/ProjectAccess';
import { TaskDetailDialog } from '../src/features/task-detail/TaskDetailDialog';
import { renderWithLocale } from './helpers/renderWithLocale';
import { detailFixture, resourceResponse, snapshotFixture } from './helpers/taskDetail';
import { createTaskSessionWorld } from './helpers/taskSessions';
import { directAccessFixture, TEST_VIEWER_ID } from './helpers/taskSync';
import { wireResponse } from './helpers/wireJson';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const projectId = id(100), taskId = id(1), otherOwnerId = id(3);
const root = `/api/v1/projects/${projectId}`;
const stamp = '2026-10-27T00:00:00Z';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const accessResponse = (role: ProjectRole, principal = TEST_VIEWER_ID) => wireResponse(directAccessFixture(projectId, TEST_VIEWER_ID, role), { headers: { 'Daynight-User-ID': principal } });
const membershipFailure = () => wireResponse({ error: { code: 'internal_error', message: 'Unavailable', requestId: 'claim-profile-read' } }, { status: 503, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
const claimRegion = () => screen.getByRole('region', { name: 'Claimed by' });
const withdraw = () => screen.queryByRole('button', { name: 'Force withdraw' });

const mount = async ({ role = 'admin', ownerId = otherOwnerId, membersFail = false, initialAccess }: {
  readonly role?: ProjectRole;
  readonly ownerId?: string;
  readonly membersFail?: boolean;
  readonly initialAccess?: () => Response | Promise<Response>;
} = {}) => {
  const mismatch = vi.fn();
  const world = createTaskSessionWorld({ onIdentityMismatch: mismatch });
  const worker: WorkerClaim = { claimId: id(2), state: 'active', userId: ownerId, workerId: id(4), machine: { id: id(5), name: 'fixture.local' }, platform: 'macos', agent: 'codex', agentControlMode: 'herdr', worktreeId: id(6), phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: stamp };
  const detail = detailFixture(projectId, taskId, { title: 'Claim access integration', status: 'in_progress', startedAt: stamp, ready: false, allowAgents: true, properties: { worker, pullRequests: [] } });
  const transport = {
    access: initialAccess ?? (() => accessResponse(role)),
    members: () => membersFail ? membershipFailure() : resourceResponse({ actorAccess: directAccessFixture(projectId, TEST_VIEWER_ID, role), items: [
      { inheritedFrom: { team: directAccessFixture(projectId).ownerTeam, role: 'member' }, userId: ownerId, profile: { name: 'Actual claim owner', email: null, avatarUrl: null }, effectiveRole: 'member', directGrant: null },
      // The roster deliberately disagrees with access: it cannot authorize withdrawal.
      ...(ownerId === TEST_VIEWER_ID ? [] : [{ inheritedFrom: { team: directAccessFixture(projectId).ownerTeam, role: role === 'admin' ? 'member' : 'admin' }, userId: TEST_VIEWER_ID, profile: { name: 'Current viewer', email: null, avatarUrl: null }, effectiveRole: role === 'admin' ? 'member' : 'admin', directGrant: null }]),
    ] }, TEST_VIEWER_ID),
  };
  const requests: string[] = [], writes: string[] = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit): Promise<Response> => {
    requests.push(url);
    if (options?.method !== undefined && options.method !== 'GET') {
      writes.push(`${options.method} ${url}`);
      throw new Error('This observation must not submit a task mutation.');
    }
    if (url === `${root}/access`) return transport.access();
    if (url === `${root}/members`) return transport.members();
    if (url === `${root}/tasks/${taskId}`) return resourceResponse(detail, TEST_VIEWER_ID);
    if (url.startsWith(`${root}/tasks/${taskId}/attachments?`)) return resourceResponse({ items: [], nextCursor: null });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  await world.sync([detail]);
  let access!: ProjectAccessSession;
  const CaptureAccess = () => { access = useProjectAccess(projectId).session; return null; };
  const container = document.createElement('div'); container.id = 'root'; document.body.append(container);
  const view = renderWithLocale(<ProjectAccessBoundary projectId={projectId}><CaptureAccess /><TaskDetailDialog projectId={projectId} taskId={taskId} snapshot={snapshotFixture([detail])} onClose={vi.fn()} onSelectTask={vi.fn()} onRestoreFocus={vi.fn()} onRefreshGraph={vi.fn()} /></ProjectAccessBoundary>, { locale: 'en', container, taskCache: { scope: world.scope } });
  cleanups.push(() => { view.unmount(); world.dispose(); container.remove(); expect(writes).toEqual([]); });
  await screen.findByRole('heading', { name: detail.title });
  await waitFor(() => expect(requests).toContain(`${root}/access`));
  await waitFor(() => expect(claimRegion()).toBeVisible());
  return { view, world, transport, requests, writes, access, mismatch };
};

describe('claim withdrawal uses independent project access', () => {
  it.each([
    { role: 'admin', ownerId: otherOwnerId, allowed: true, membersFail: false },
    { role: 'admin', ownerId: otherOwnerId, allowed: true, membersFail: true },
    { role: 'member', ownerId: otherOwnerId, allowed: false, membersFail: false },
    { role: 'member', ownerId: otherOwnerId, allowed: false, membersFail: true },
    { role: 'member', ownerId: TEST_VIEWER_ID, allowed: true, membersFail: false },
    { role: 'member', ownerId: TEST_VIEWER_ID, allowed: true, membersFail: true },
  ] as const)('uses $role access for owner $ownerId with membersFail=$membersFail', async (scenario) => {
    const mounted = await mount(scenario);
    await waitFor(() => expect(mounted.access.snapshot()).toMatchObject({ status: 'ready', refreshing: false }));
    if (scenario.membersFail) {
      expect(await within(claimRegion()).findByRole('alert')).toHaveTextContent('claim-profile-read');
      expect(within(claimRegion()).getByText(scenario.ownerId, { selector: 'strong' })).toBeVisible();
    } else expect(await within(claimRegion()).findByText('Actual claim owner', { selector: 'strong' })).toBeVisible();
    if (scenario.allowed) expect(withdraw()).toBeEnabled();
    else expect(withdraw()).toBeNull();
    expect(screen.queryByText('Current viewer', { selector: '.task-claim strong' })).toBeNull();
  });

  it('does not offer withdrawal until the initial access request is ready, even when the owner profile is available', async () => {
    const pending = Promise.withResolvers<Response>();
    const mounted = await mount({ initialAccess: () => pending.promise });
    expect(await within(claimRegion()).findByText('Actual claim owner')).toBeVisible();
    expect(mounted.access.snapshot()).toMatchObject({ status: 'loading', refreshing: true });
    expect(withdraw()).toBeNull();
    await act(async () => { pending.resolve(accessResponse('admin')); await mounted.access.revalidate(); });
    await waitFor(() => expect(withdraw()).toBeEnabled());
  });

  it('blocks stale admin rights during refresh and after a failed access read, then follows the freshly confirmed role', async () => {
    const mounted = await mount();
    await waitFor(() => expect(withdraw()).toBeEnabled());
    const pending = Promise.withResolvers<Response>();
    mounted.transport.access = () => pending.promise;
    let refresh!: ReturnType<ProjectAccessSession['revalidate']>;
    act(() => { refresh = mounted.access.revalidate(); });
    expect(mounted.access.snapshot()).toMatchObject({ status: 'ready', refreshing: true, access: { effectiveRole: 'admin' } });
    expect(withdraw()).toBeNull();
    await act(async () => {
      pending.resolve(wireResponse({ error: { code: 'internal_error', message: 'Unavailable', requestId: 'claim-access-read' } }, { status: 503, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } }));
      await refresh;
    });
    expect(mounted.access.snapshot()).toMatchObject({ status: 'error', refreshing: false, access: { effectiveRole: 'admin' } });
    expect(await screen.findByText('claim-access-read')).toBeVisible();
    expect(withdraw()).toBeNull();
    expect(within(claimRegion()).getByText('Actual claim owner')).toBeVisible();
    mounted.transport.access = () => accessResponse('member');
    await act(async () => { await mounted.access.revalidate(); });
    expect(mounted.access.snapshot()).toMatchObject({ status: 'ready', refreshing: false, access: { effectiveRole: 'member' } });
    expect(withdraw()).toBeNull();
    mounted.transport.access = () => accessResponse('admin');
    await act(async () => { await mounted.access.revalidate(); });
    expect(withdraw()).toBeEnabled();
    expect(screen.queryByText('claim-access-read')).toBeNull();
  });

  it('revalidates before opening withdrawal confirmation and refuses a newly downgraded administrator', async () => {
    const mounted = await mount();
    await waitFor(() => expect(withdraw()).toBeEnabled());
    const accessReads = mounted.requests.filter((url) => url === `${root}/access`).length;
    mounted.transport.access = () => accessResponse('member');
    fireEvent.click(withdraw()!);
    await waitFor(() => expect(mounted.requests.filter((url) => url === `${root}/access`)).toHaveLength(accessReads + 1));
    await waitFor(() => expect(mounted.access.snapshot()).toMatchObject({ refreshing: false, access: { effectiveRole: 'member' } }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(withdraw()).toBeNull();
  });
});
