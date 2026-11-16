import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as auth from '../src/api/auth';
import { ApiError } from '../src/api/client';
import { getProject } from '../src/api/project-settings';
import { MembersPanel } from '../src/features/management/MembersPanel';
import { createLocaleRender } from './helpers/renderWithLocale';
import { directAccessFixture } from './helpers/taskSync';

vi.mock('../src/api/auth', () => ({ getProjectAccess: vi.fn(), listMembers: vi.fn(), listInvitations: vi.fn(), createInvitation: vi.fn(), revokeInvitation: vi.fn(), setProjectGrant: vi.fn(), removeProjectGrant: vi.fn() }));
vi.mock('../src/api/project-settings', () => ({ getProject: vi.fn() }));
const a = '00000000-0000-4000-8000-000000000101', b = '00000000-0000-4000-8000-000000000102';
const user = { id: '00000000-0000-4000-8000-000000000201', name: 'Alice', email: null, emailVerified: true, avatarUrl: null, personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null } };
const render = createLocaleRender('zh-CN', { taskCache: { viewerId: user.id } });
const subtitle = (name: string) => `${name} · 管理协作成员与加入邀请`;
const panel = (id: string, name: string | null) => <MembersPanel projectId={id} projectName={name} user={user} onRemoved={vi.fn()} />;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auth.getProjectAccess).mockImplementation(async (id) => directAccessFixture(id, user.id, 'admin'));
  vi.mocked(auth.listMembers).mockImplementation(async (id) => ({ items: [], actorAccess: directAccessFixture(id, user.id, 'admin') }));
  vi.mocked(auth.listInvitations).mockResolvedValue([]);
});

it('uses each workspace-owned project name without an independent project read', async () => {
  const view = render(<><section aria-label="Alpha">{panel(a, 'Project Alpha')}</section><section aria-label="Beta">{panel(b, null)}</section></>);
  expect(within(screen.getByRole('region', { name: 'Alpha' })).getByText(subtitle('Project Alpha'))).toBeInTheDocument();
  expect(screen.queryByText(subtitle('Project Beta'))).toBeNull();
  view.rerender(<><section aria-label="Alpha">{panel(a, 'Renamed Alpha')}</section><section aria-label="Beta">{panel(b, 'Project Beta')}</section></>);
  expect(within(screen.getByRole('region', { name: 'Alpha' })).getByText(subtitle('Renamed Alpha'))).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Beta' })).getByText(subtitle('Project Beta'))).toBeInTheDocument();
  expect(screen.queryByText(subtitle('Project Alpha'))).toBeNull();
  await waitFor(() => expect(auth.listMembers).toHaveBeenCalled());
  expect(getProject).not.toHaveBeenCalled();
});

it('withdraws the shared name after confirmed project access loss', async () => {
  render(panel(a, 'Project Alpha'));
  await waitFor(() => expect(auth.listMembers).toHaveBeenCalled());
  expect(screen.getByText(subtitle('Project Alpha'))).toBeVisible();
  vi.mocked(auth.getProjectAccess).mockRejectedValue(new ApiError('server', 404, 'not_found'));
  fireEvent(window, new Event('focus'));
  await screen.findByText('项目不存在或你没有访问权限。');
  expect(screen.queryByText(subtitle('Project Alpha'))).toBeNull();
  expect(getProject).not.toHaveBeenCalled();
});
