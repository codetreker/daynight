import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invalidateAuthRequests } from '../src/api/client';
import { ProjectSettingsWorkspace } from '../src/features/management/project-settings/ProjectSettingsWorkspace';
import { createLocaleRender } from './helpers/renderWithLocale';
import { directAccessFixture } from './helpers/taskSync';
import { stringifyWireJson } from './helpers/wireJson';

const settings = vi.hoisted(() => ({ unavailable: false }));
vi.mock('../src/features/management/useProjectSettings', () => ({ useProjectSettings: () => ({ unavailable: settings.unavailable, project: null, dirty: false, summaryPending: false, invalid: false, draftConflict: false, uncertain: false, reconciliation: null, error: null, writeError: null }) }));
vi.mock('../src/features/management/project-settings/ExecutionSettingsSection', () => ({ ExecutionSettingsSection: () => null }));
vi.mock('../src/features/github-integration/ProjectGitHubConsumption', () => ({ ProjectGitHubConsumption: () => null }));
vi.mock('../src/features/management/ProjectOwnership', () => ({ ProjectOwnership: () => null }));
vi.mock('../src/features/management/ProjectDeletion', () => ({ ProjectDeletion: () => null }));
vi.mock('../src/features/management/AccountPage', () => ({ usePromptNavigation: () => ({ owner: null, rememberFocus: () => {}, confirmation: null }) }));
vi.mock('../src/features/worker-prompts/useWorkerPrompt', () => ({ useWorkerPrompt: () => ({ pending: false, confirmed: false, uncertain: false, dirty: false, readError: null, writeError: null, conflict: false, invalid: false, tooLarge: false }) }));
vi.mock('../src/features/worker-prompts/WorkerPromptEditor', () => ({ WorkerPromptEditor: () => null }));

const actor = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000002';
const project = '00000000-0000-4000-8000-000000000003';
const team = '00000000-0000-4000-8000-000000000701';
const stamp = '2026-10-22T10:00:00Z';
const user = { id: actor, name: 'Alice', email: 'alice@example.test', emailVerified: true, avatarUrl: null, personalTeam: { id: team, kind: 'personal' as const, name: null } };
const access = directAccessFixture(project, actor, 'admin');
const member = { userId: actor, profile: { name: 'Alice', email: 'alice@example.test', avatarUrl: null }, effectiveRole: 'admin', directGrant: { projectId: project, userId: actor, role: 'admin', version: 1n, createdAt: stamp, updatedAt: stamp }, inheritedFrom: null };
const json = (body: unknown) => new Response(stringifyWireJson(body), { status: 200, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': actor } });
afterEach(() => { settings.unavailable = false; invalidateAuthRequests(); });

it('hides the body portal when the settings workspace is unavailable', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn((url: string): Promise<Response> => {
    if (url.endsWith('/access')) return Promise.resolve(json(access));
    if (url.endsWith('/members')) return Promise.resolve(json({ items: [member], actorAccess: access }));
    if (url.endsWith('/invitations')) return Promise.resolve(json({ items: [] }));
    if (url.endsWith('/member-candidates/search')) return Promise.resolve(json({ items: [{ userId: target, profile: { name: 'Private candidate', email: null, avatarUrl: null } }], nextCursor: null, actorRole: 'admin' }));
    throw new Error(`Unexpected request ${url}`);
  }));
  const panel = () => <ProjectSettingsWorkspace projectId={project} user={user} selection={{ kind: 'tab', tab: 'members' }} unavailableView={<p>Project unavailable</p>} />;
  const view = createLocaleRender('en')(panel(), { taskCache: { viewerId: actor } });
  const input = await screen.findByRole('searchbox', { name: 'Search and add members' });
  fireEvent.focus(input); fireEvent.change(input, { target: { value: 'private' } });
  const dialog = await screen.findByRole('dialog', { name: 'Search users and add to project' });
  expect(await within(dialog).findByText('Private candidate')).toBeVisible();
  settings.unavailable = true; view.rerender(panel());
  expect(screen.getByText('Project unavailable')).toBeVisible();
  expect(dialog).not.toBeVisible();
  expect(screen.queryByRole('dialog', { name: 'Search users and add to project' })).toBeNull();
});
