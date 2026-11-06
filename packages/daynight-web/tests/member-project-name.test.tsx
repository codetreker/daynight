import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as auth from '../src/api/auth';
import { ApiError } from '../src/api/client';
import { getProject } from '../src/api/project-settings';
import type { Project } from '../src/api/types';
import { MembersPanel } from '../src/features/management/MembersPanel';
import { createLocaleRender } from './helpers/renderWithLocale';
import { directAccessFixture } from './helpers/taskSync';

vi.mock('../src/api/auth', () => ({ getProjectAccess: vi.fn(), listMembers: vi.fn(), listInvitations: vi.fn(), createInvitation: vi.fn(), revokeInvitation: vi.fn(), setProjectGrant: vi.fn(), removeProjectGrant: vi.fn() }));
vi.mock('../src/api/project-settings', () => ({ getProject: vi.fn() }));
const a = '00000000-0000-4000-8000-000000000101', b = '00000000-0000-4000-8000-000000000102';
const user = { id: '00000000-0000-4000-8000-000000000201', name: 'Alice', email: null, emailVerified: true, avatarUrl: null, personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null } };
const render = createLocaleRender('zh-CN', { taskCache: { viewerId: user.id } });
const project = (id: string, name = id === a ? 'Project Alpha' : 'Project Beta') => ({ id, name } as Project);
const subtitle = (name: string) => `${name} · 管理协作成员与加入邀请`;
const panel = (id = a, active = true) => <MembersPanel projectId={id} user={user} onRemoved={vi.fn()} active={active} />;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auth.getProjectAccess).mockImplementation(async (id) => directAccessFixture(id, user.id, 'admin'));
  vi.mocked(auth.listMembers).mockImplementation(async (id) => ({ items: [], actorAccess: directAccessFixture(id, user.id, 'admin') }));
  vi.mocked(auth.listInvitations).mockResolvedValue([]);
  vi.mocked(getProject).mockImplementation(async (id) => project(id));
});

it('reads the current project directly and keeps two mounted member panels independent', async () => {
  render(<><section aria-label="Alpha">{panel(a)}</section><section aria-label="Beta">{panel(b)}</section></>);
  expect(await within(screen.getByRole('region', { name: 'Alpha' })).findByText(subtitle('Project Alpha'))).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Beta' })).getByText(subtitle('Project Beta'))).toBeInTheDocument();
  expect(screen.queryByText(subtitle('Wrong project'))).toBeNull();
});

it('keeps the subtitle reserved while reading and retries name failure independently of the directory', async () => {
  const read = deferred<Project>(); vi.mocked(getProject).mockReturnValueOnce(read.promise).mockRejectedValueOnce(new ApiError('server', 503)).mockResolvedValue(project(a));
  const view = render(panel());
  await waitFor(() => expect(getProject).toHaveBeenCalledOnce());
  expect(screen.queryByText(subtitle('Wrong project'))).toBeNull();
  expect(screen.getByRole('button', { name: '邀请成员' })).toBeInTheDocument();
  await act(async () => read.resolve(project(a)));
  expect(screen.getByText(subtitle('Project Alpha'))).toBeInTheDocument();
  view.rerender(panel(a, false)); view.rerender(panel(a));
  await screen.findByRole('alert');
  expect(screen.queryByText(subtitle('Project Alpha'))).toBeNull();
  const reads = vi.mocked(auth.listMembers).mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await screen.findByText(subtitle('Project Alpha'));
  expect(auth.listMembers).toHaveBeenCalledTimes(reads);
});

it('clears a revoked name and rejects a late response from the earlier access generation', async () => {
  const pending = deferred<Project>(); const view = render(panel());
  await screen.findByText(subtitle('Project Alpha'));
  vi.mocked(getProject).mockReturnValueOnce(pending.promise);
  view.rerender(panel(a, false)); view.rerender(panel(a));
  await waitFor(() => expect(getProject).toHaveBeenCalledTimes(2));
  vi.mocked(auth.getProjectAccess).mockRejectedValue(new ApiError('server', 404, 'not_found'));
  fireEvent(window, new Event('focus'));
  await screen.findByText('项目不存在或你没有访问权限。');
  expect(screen.queryByText(subtitle('Project Alpha'))).toBeNull();
  await act(async () => pending.resolve(project(a, 'Revoked name')));
  expect(screen.queryByText(subtitle('Revoked name'))).toBeNull();
});

it('ignores an old project response after route replacement', async () => {
  const pending = deferred<Project>(); vi.mocked(getProject).mockImplementation((id) => id === a ? pending.promise : Promise.resolve(project(id)));
  const view = render(panel()); await waitFor(() => expect(getProject).toHaveBeenCalledOnce());
  view.rerender(panel(b)); await screen.findByText(subtitle('Project Beta'));
  await act(async () => pending.resolve(project(a)));
  expect(screen.queryByText(subtitle('Project Alpha'))).toBeNull();
});
