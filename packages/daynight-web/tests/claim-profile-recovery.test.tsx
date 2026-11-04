import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLayoutEffect, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerClaim } from '../src/api/types';
import { ProjectMembersProvider, useProjectMembers } from '../src/features/projects/ProjectMembers';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { TaskClaimSummary } from '../src/features/task-detail/TaskClaim';
import { renderWithLocale } from './helpers/renderWithLocale';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const projectId = id(100), otherProjectId = id(101), ownerId = id(3);
const stamp = '2026-10-27T00:00:00Z';
const worker: WorkerClaim = { claimId: id(2), state: 'active', userId: ownerId, workerId: id(4), machine: { id: id(5), name: 'fixture.local' }, platform: 'macos', agent: 'codex', agentControlMode: 'herdr', worktreeId: id(6), phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: stamp };
const participant = (name = 'Claim owner', userId = ownerId) => ({ userId, profile: { name, email: null, avatarUrl: null }, effectiveRole: 'member', directGrant: null });
const response = (items: readonly unknown[] = [participant()], userId = TEST_VIEWER_ID) => Response.json({ items }, { headers: viewerHeaders(userId) });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
};
const scopes: TaskCacheScope[] = [];
const scope = (userId = TEST_VIEWER_ID, onIdentityMismatch = vi.fn()) => {
  const value = createTaskCacheScope({ userId, onIdentityMismatch });
  scopes.push(value);
  return value;
};
afterEach(() => { for (const value of scopes.splice(0)) value.dispose(); });

const Claim = ({ project = projectId, claim = worker, observe }: {
  readonly project?: string;
  readonly claim?: WorkerClaim;
  readonly observe?: (names: readonly (string | null)[]) => void;
}) => {
  const members = useProjectMembers(project);
  useLayoutEffect(() => { observe?.(members.members.map((item) => item.profile.name)); });
  return <TaskClaimSummary worker={claim} members={members.members} membershipStatus={members.status} membershipError={members.error} onRetryMembers={members.retry} canWithdraw={false} />;
};
const Boundary = ({ owner, children }: { readonly owner: TaskCacheScope; readonly children: ReactNode }) => <TaskCacheProvider scope={owner}>{children}</TaskCacheProvider>;
const mount = (children: ReactElement) => renderWithLocale(children, { locale: 'en' });

describe('claim profiles through the membership transport', () => {
  it('decodes nested grant versions and displays the actual claim owner rather than another participant', async () => {
    const body = JSON.stringify({ items: [participant('Current viewer', TEST_VIEWER_ID), {
      ...participant(), directGrant: { projectId, userId: ownerId, role: 'member', version: 1, createdAt: stamp, updatedAt: stamp },
    }] }).replace('"version":1', '"version":9007199254740993');
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) }));
    vi.stubGlobal('fetch', fetcher);
    mount(<Boundary owner={scope()}><Claim /></Boundary>);
    expect(await screen.findByText('Claim owner', { selector: 'strong' })).toBeVisible();
    expect(screen.queryByText('Current viewer')).toBeNull();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${projectId}/members`, expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) }));
  });

  it.each(['network', 'malformed', 'legacy'] as const)('retains a %s failure through another failed retry and recovers only from a valid response', async (failure) => {
    const fetcher = vi.fn();
    if (failure === 'network') fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    else if (failure === 'malformed') fetcher.mockResolvedValueOnce(new Response('{', { headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) }));
    else fetcher.mockResolvedValueOnce(Response.json({ items: [{ projectId, userId: ownerId, name: 'Legacy name', email: null, avatarUrl: null, role: 'member', version: 1, createdAt: stamp, updatedAt: stamp }] }, { headers: viewerHeaders(TEST_VIEWER_ID) }));
    fetcher.mockResolvedValueOnce(Response.json({ items: [{ ...participant(), profile: {} }] }, { headers: viewerHeaders(TEST_VIEWER_ID) })).mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetcher);
    mount(<Boundary owner={scope()}><Claim /></Boundary>);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.getByText(ownerId, { selector: 'strong' })).toBeVisible();
    expect(screen.queryByText('Legacy name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry member details' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('alert')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry member details' }));
    expect(await screen.findByText('Claim owner')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('retries the shared provider after a consumer closes and reopens without losing the source error', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(response());
    vi.stubGlobal('fetch', fetcher);
    const owner = scope();
    const children = (open: boolean) => <Boundary owner={owner}><ProjectMembersProvider projectId={projectId}>{open && <><Claim /><Claim /></>}</ProjectMembersProvider></Boundary>;
    const view = mount(children(true));
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    view.rerender(children(false));
    view.rerender(children(true));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry member details' })[0]!);
    await waitFor(() => expect(screen.getAllByText('Claim owner')).toHaveLength(2));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not inherit another account scope even when its project matches', async () => {
    const outer = scope(), inner = scope(id(202));
    const fetcher = vi.fn().mockResolvedValueOnce(response([participant('Outer account profile')])).mockResolvedValueOnce(response([participant('Inner account profile')], inner.userId));
    vi.stubGlobal('fetch', fetcher);
    const view = mount(<Boundary owner={outer}><ProjectMembersProvider projectId={projectId}><Claim /></ProjectMembersProvider></Boundary>);
    expect(await screen.findByText('Outer account profile')).toBeVisible();
    const observed: (readonly (string | null)[])[] = [];
    view.rerender(<Boundary owner={outer}><ProjectMembersProvider projectId={projectId}><Boundary owner={inner}><Claim observe={(names) => observed.push(names)} /></Boundary></ProjectMembersProvider></Boundary>);
    expect(await screen.findByText('Inner account profile')).toBeVisible();
    expect(observed.flat()).not.toContain('Outer account profile');
  });

  it('hides a previous account snapshot on the first commit after its scope changes', async () => {
    const first = scope(), next = scope(id(202));
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response([participant('Previous account profile')])).mockReturnValueOnce(pending.promise));
    const view = mount(<Boundary owner={first}><Claim /></Boundary>);
    expect(await screen.findByText('Previous account profile')).toBeVisible();
    const observed: (readonly (string | null)[])[] = [];
    view.rerender(<Boundary owner={next}><Claim observe={(names) => observed.push(names)} /></Boundary>);
    expect(observed.flat()).not.toContain('Previous account profile');
    await act(async () => pending.resolve(response([participant('Next account profile')], next.userId)));
    expect(await screen.findByText('Next account profile')).toBeVisible();
  });

  it.each(['project', 'account'] as const)('ignores a late response from the previous %s', async (change) => {
    const first = scope(), next = change === 'account' ? scope(id(202)) : first;
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response([participant('Current profile')], next.userId));
    vi.stubGlobal('fetch', fetcher);
    const view = mount(<Boundary owner={first}><Claim /></Boundary>);
    view.rerender(<Boundary owner={next}><Claim project={change === 'project' ? otherProjectId : projectId} /></Boundary>);
    expect(await screen.findByText('Current profile')).toBeVisible();
    await act(async () => pending.resolve(response([participant('Late profile')])));
    expect(screen.queryByText('Late profile')).toBeNull();
    expect(screen.getByText('Current profile')).toBeVisible();
    expect(fetcher.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it('matches a replacement claim to its own user when the project lookup finishes', async () => {
    const pending = deferred<Response>(), owner = scope();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(pending.promise));
    const view = mount(<Boundary owner={owner}><Claim /></Boundary>);
    view.rerender(<Boundary owner={owner}><Claim claim={{ ...worker, claimId: id(20), userId: id(21) }} /></Boundary>);
    await act(async () => pending.resolve(response([participant('Previous claim owner'), participant('New claim owner', id(21))])));
    expect(await screen.findByText('New claim owner', { selector: 'strong' })).toBeVisible();
    expect(screen.queryByText('Previous claim owner')).toBeNull();
  });

  it('distinguishes an absent participant from an existing participant without profile names', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([{ ...participant(), profile: { name: null, email: null, avatarUrl: null } }]));
    vi.stubGlobal('fetch', fetcher);
    const owner = scope();
    const view = mount(<Boundary owner={owner}><Claim /></Boundary>);
    expect(await screen.findByText('Former project member')).toBeVisible();
    view.rerender(<Boundary owner={owner}><Claim project={otherProjectId} /></Boundary>);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(within(screen.getByRole('region')).getByText(ownerId, { selector: 'strong' })).toBeVisible();
    expect(screen.queryByText('Former project member')).toBeNull();
  });

  it('rejects a response belonging to another principal before displaying its profile', async () => {
    const mismatch = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([participant('Other principal profile')], id(202))));
    mount(<Boundary owner={scope(TEST_VIEWER_ID, mismatch)}><Claim /></Boundary>);
    await waitFor(() => expect(mismatch).toHaveBeenCalledOnce());
    expect(screen.queryByText('Other principal profile')).toBeNull();
  });
});
