import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAuthRequests } from '../src/api/client';
import { MembersPanel } from '../src/features/management/MembersPanel';
import { ProjectAccessBoundary, useProjectAccessSession, type ProjectAccessSession } from '../src/features/projects/ProjectAccess';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { TaskCacheLifecycleChanged } from '../src/features/task-cache/project-cache';
import { createLocaleRender } from './helpers/renderWithLocale';
import { directAccessFixture } from './helpers/taskSync';
import { stringifyWireJson } from './helpers/wireJson';

const actor = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000002';
const project = '00000000-0000-4000-8000-000000000003';
const team = '00000000-0000-4000-8000-000000000701';
const stamp = '2026-10-22T10:00:00Z';
const user = { id: actor, name: 'Alice', email: 'alice@example.test', emailVerified: true, avatarUrl: null, personalTeam: { id: team, kind: 'personal' as const, name: null } };
const profile = { name: 'Target', email: 'target@example.test', avatarUrl: null };
const participant = (userId: string, role: 'admin' | 'member') => ({ userId, profile: userId === target ? profile : { name: 'Alice', email: 'alice@example.test', avatarUrl: null }, effectiveRole: role, directGrant: { projectId: project, userId, role, version: 1n, createdAt: stamp, updatedAt: stamp }, inheritedFrom: null });
const json = (body: unknown, principal = actor, status = 200) => new Response(stringifyWireJson(body), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
const render = createLocaleRender('en');

const scopes: ReturnType<typeof createTaskCacheScope>[] = [];

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => { for (const scope of scopes.splice(0)) scope.dispose(); invalidateAuthRequests(); vi.restoreAllMocks(); });

const setup = () => {
  let role: 'admin' | 'member' = 'admin';
  let roster = [participant(actor, 'admin')];
  let invitationFails = false;
  let rosterFails = false;
  let heldRoster: PromiseWithResolvers<Response> | null = null;
  const write = Promise.withResolvers<Response>();
  const scope = createTaskCacheScope({ userId: actor, onIdentityMismatch: vi.fn() });
  scopes.push(scope);
  const guard = vi.fn();
  const fetcher = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
    if (url === `/api/v1/projects/${project}/access`) return Promise.resolve(json(directAccessFixture(project, actor, role)));
    if (url === `/api/v1/projects/${project}/members` && !init?.method) {
      if (heldRoster !== null) { const held = heldRoster; heldRoster = null; return held.promise; }
      return rosterFails ? Promise.reject(new TypeError('roster unavailable')) : Promise.resolve(json({ items: roster, actorAccess: directAccessFixture(project, actor, role) }));
    }
    if (url === `/api/v1/projects/${project}/invitations`) return invitationFails ? Promise.reject(new TypeError('invitations unavailable')) : Promise.resolve(json({ items: [] }));
    if (url === `/api/v1/projects/${project}/member-candidates/search`) return Promise.resolve(json({ items: [{ userId: target, profile }], nextCursor: null, actorRole: 'admin' }));
    if (url === `/api/v1/projects/${project}/members/${target}` && init?.method === 'POST') return write.promise;
    if (url === `/api/v1/projects/${project}/grants/${actor}` && init?.method === 'PUT') return Promise.reject(new TypeError('grant response lost'));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  let session: ProjectAccessSession | null = null;
  const Probe = () => { session = useProjectAccessSession(project); return null; };
  const panel = (active = true) => <ProjectAccessBoundary projectId={project} initialRead active={active}><Probe /><MembersPanel projectId={project} user={user} active={active} onRemoved={vi.fn()} onGuardChange={guard} /></ProjectAccessBoundary>;
  const view = render(panel(), { taskCache: { scope } });
  return { ...view, panel, fetcher, write, scope, guard, session: () => session!, setRole: (next: typeof role) => { role = next; roster = [participant(actor, next)]; }, setRoster: (next: typeof roster) => { roster = next; }, setInvitationFails: () => { invitationFails = true; }, setRosterFails: (next: boolean) => { rosterFails = next; }, holdRoster: () => { const held = Promise.withResolvers<Response>(); heldRoster = held; return held; } };
};

const search = async (term = 'target') => {
  const input = await screen.findByRole('searchbox', { name: 'Search and add members' });
  fireEvent.focus(input); fireEvent.change(input, { target: { value: term } });
  const dialog = await screen.findByRole('dialog', { name: 'Search users and add to project' });
  await within(dialog).findByRole('button', { name: new RegExp(`^(Add|Check status|Joined) Target, target@example.test, Account ${target}$`) });
  return { input, dialog };
};
const add = async (fixture: ReturnType<typeof setup>) => {
  const ui = await search();
  fireEvent.click(within(ui.dialog).getByRole('button', { name: `Add Target, target@example.test, Account ${target}` }));
  await waitFor(() => expect(fixture.fetcher.mock.calls.filter(([url, init]) => url.endsWith(`/members/${target}`) && init?.method === 'POST')).toHaveLength(1));
  return ui;
};
const receipt = () => json({ added: true, participant: participant(target, 'member'), actorAccess: directAccessFixture(project, actor, 'admin') });

describe('project member addition', () => {
  it.each(['absent', 'present', 'failed'] as const)('keeps an unknown write locked after clearing the query and checking a %s roster independently of invitations', async (outcome) => {
    const fixture = setup(); const ui = await add(fixture);
    await act(async () => fixture.write.reject(new TypeError('lost response')));
    await screen.findByText(/Checking current members does not unlock another add/);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(ui.input).toHaveValue('');
    fixture.setInvitationFails();
    if (outcome === 'present') fixture.setRoster([participant(actor, 'admin'), participant(target, 'member')]);
    if (outcome === 'failed') fixture.setRosterFails(true);
    fireEvent.click(screen.getByRole('button', { name: 'Read current members' }));
    if (outcome === 'failed') await screen.findByText(/The operation could not be completed/i);
    else await screen.findByText(outcome === 'present' ? 'Currently a member.' : 'Not currently a project member.');
    fixture.setRosterFails(false);
    const next = await search();
    const action = within(next.dialog).getByRole('button', { name: new RegExp(`^(Check status|Joined) Target, target@example.test, Account ${target}$`) });
    expect(action).toHaveAttribute('aria-disabled', 'true'); fireEvent.click(action);
    expect(fixture.fetcher.mock.calls.filter(([url, init]) => url.endsWith(`/members/${target}`) && init?.method === 'POST')).toHaveLength(1);
  });

  it('applies a confirmed write after the search query changes', async () => {
    const fixture = setup(); const ui = await add(fixture);
    fireEvent.change(ui.input, { target: { value: 'another' } });
    await act(async () => fixture.write.resolve(receipt()));
    expect(await screen.findByText('Target', { selector: '.person-name' })).toBeVisible();
    expect(ui.input).toHaveValue('another');
  });

  it('does not reinsert a stale receipt after a newer roster observation', async () => {
    const fixture = setup();
    const role = await screen.findByRole('combobox', { name: 'Direct grant for Alice' });
    fireEvent.change(role, { target: { value: 'member' } });
    const dialog = await screen.findByRole('dialog', { name: 'Change direct grant for Alice?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save role' }));
    await screen.findByText(/The service did not confirm the member change/);
    await add(fixture);
    const priorReads = fixture.fetcher.mock.calls.filter(([url, init]) => url.endsWith('/members') && !init?.method).length;
    fireEvent.click(screen.getByRole('button', { name: 'Read current members' }));
    await screen.findByText(/Current members have been read/);
    expect(fixture.fetcher.mock.calls.filter(([url, init]) => url.endsWith('/members') && !init?.method)).toHaveLength(priorReads + 1);
    await act(async () => fixture.write.resolve(receipt()));
    await waitFor(() => expect(fixture.fetcher.mock.calls.filter(([url, init]) => url.endsWith('/members') && !init?.method).length).toBeGreaterThan(priorReads + 1));
    expect(screen.queryByText('Target', { selector: '.person-name' })).toBeNull();
  });

  it('removes candidates on loss of admin and keeps unknown protection after restoration', async () => {
    const fixture = setup(); await add(fixture);
    await act(async () => fixture.write.reject(new TypeError('lost response')));
    await screen.findByText(/Checking current members does not unlock another add/);
    fixture.setRole('member'); fixture.rerender(fixture.panel(false)); fixture.rerender(fixture.panel(true));
    await waitFor(() => expect(screen.queryByRole('searchbox', { name: 'Search and add members' })).toBeNull());
    expect(screen.queryByText('target@example.test')).toBeNull();
    fixture.setRole('admin'); fixture.rerender(fixture.panel(false)); fixture.rerender(fixture.panel(true));
    await screen.findByRole('searchbox', { name: 'Search and add members' });
    expect(screen.queryByText('target@example.test')).toBeNull();
    const next = await search();
    const action = within(next.dialog).getByRole('button', { name: `Check status Target, target@example.test, Account ${target}` });
    expect(action).toHaveAttribute('aria-disabled', 'true');
  });

  it('does not publish an old identity receipt after a new account is admitted', async () => {
    const fixture = setup(); await add(fixture);
    await act(async () => { await fixture.scope.invalidateScope(); });
    fixture.unmount();
    const nextActor = '00000000-0000-4000-8000-000000000004';
    const nextScope = createTaskCacheScope({ userId: nextActor, onIdentityMismatch: vi.fn() });
    scopes.push(nextScope);
    const nextAccess = directAccessFixture(project, nextActor, 'admin');
    const nextMember = { ...participant(actor, 'admin'), userId: nextActor, profile: { name: 'New account', email: null, avatarUrl: null }, directGrant: { ...participant(actor, 'admin').directGrant, userId: nextActor } };
    vi.stubGlobal('fetch', vi.fn((url: string): Promise<Response> => {
      if (url.endsWith('/access')) return Promise.resolve(json(nextAccess, nextActor));
      if (url.endsWith('/members')) return Promise.resolve(json({ items: [nextMember], actorAccess: nextAccess }, nextActor));
      if (url.endsWith('/invitations')) return Promise.resolve(json({ items: [] }, nextActor));
      throw new Error(`Unexpected request ${url}`);
    }));
    const view = render(<MembersPanel projectId={project} user={{ ...user, id: nextActor, name: 'New account' }} onRemoved={vi.fn()} />, { taskCache: { scope: nextScope } });
    expect(await screen.findByText('New account', { selector: '.person-name' })).toBeVisible();
    await act(async () => fixture.write.resolve(receipt()));
    expect(screen.queryByText('Target', { selector: '.person-name' })).toBeNull();
    expect(screen.queryByText(/Checking current members does not unlock another add/)).toBeNull();
    view.unmount(); nextScope.dispose(); fixture.scope.dispose();
  });


  it('clears private candidates after a downgrade and restoration in the same update batch', async () => {
    const fixture = setup(); const ui = await search();
    const requests = fixture.fetcher.mock.calls.filter(([url]) => url.endsWith('/member-candidates/search')).length;
    act(() => {
      fixture.session().publishMutation(directAccessFixture(project, actor, 'member'));
      fixture.session().publishMutation(directAccessFixture(project, actor, 'admin'));
    });
    expect(ui.input).toHaveValue('');
    expect(screen.queryByText('target@example.test')).toBeNull();
    expect(fixture.fetcher.mock.calls.filter(([url]) => url.endsWith('/member-candidates/search'))).toHaveLength(requests);
  });


  it('clears foreground loading when an unknown-add check supersedes a pending roster read', async () => {
    const fixture = setup();
    const role = await screen.findByRole('combobox', { name: 'Direct grant for Alice' });
    fireEvent.change(role, { target: { value: 'member' } });
    const dialog = await screen.findByRole('dialog', { name: 'Change direct grant for Alice?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save role' }));
    const grantIssue = await screen.findByText(/The service did not confirm the member change/);
    await add(fixture); await act(async () => fixture.write.reject(new TypeError('lost response')));
    const addIssue = await screen.findByText(/Checking current members does not unlock another add/);
    const held = fixture.holdRoster();
    const before = fixture.fetcher.mock.calls.filter(([url, init]) => url.endsWith('/members') && !init?.method).length;
    fireEvent.click(within(grantIssue.closest('.notice') as HTMLElement).getByRole('button', { name: 'Read current members' }));
    await waitFor(() => expect(fixture.fetcher.mock.calls.filter(([url, init]) => url.endsWith('/members') && !init?.method)).toHaveLength(before + 1));
    expect(screen.getByText('Loading project members…')).toBeVisible();
    fireEvent.click(within(addIssue.closest('.notice') as HTMLElement).getByRole('button', { name: 'Read current members' }));
    await screen.findByText('Not currently a project member.');
    expect(screen.queryByText('Loading project members…')).toBeNull();
    expect(screen.getByText('Alice', { selector: '.person-name' })).toBeVisible();
    await act(async () => held.resolve(json({ items: [participant(actor, 'admin')], actorAccess: directAccessFixture(project, actor, 'admin') })));
  });


  it.each(['confirmed', 'unknown'] as const)('retains the %s result through repeated retryable admission changes', async (outcome) => {
    const fixture = setup(); await add(fixture);
    const ready = fixture.scope.ready.bind(fixture.scope);
    let failures = 0;
    vi.spyOn(fixture.scope, 'ready').mockImplementation(async signal => {
      if (failures < 2) { failures++; throw new TaskCacheLifecycleChanged(); }
      return ready(signal);
    });
    if (outcome === 'confirmed') {
      await act(async () => fixture.write.resolve(receipt()));
      expect(await screen.findByText('Target', { selector: '.person-name' })).toBeVisible();
    } else {
      await act(async () => fixture.write.reject(new TypeError('lost response')));
      await screen.findByText(/Checking current members does not unlock another add/);
      const action = screen.getByRole('button', { name: `Check status Target, target@example.test, Account ${target}` });
      expect(action).toHaveAttribute('aria-disabled', 'true');
    }
    expect(failures).toBe(2);
    expect(fixture.fetcher.mock.calls.filter(([url, init]) => url.endsWith(`/members/${target}`) && init?.method === 'POST')).toHaveLength(1);
  });

});
