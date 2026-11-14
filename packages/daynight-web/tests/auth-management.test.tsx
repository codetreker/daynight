import { getProject } from '../src/api/project-settings';
import type { Project } from '../src/api/types';
import { directAccessFixture } from "./helpers/taskSync";
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocaleRender } from './helpers/renderWithLocale';
import { waitForState } from './helpers/waitForState';
import * as auth from '../src/api/auth';
import * as grants from '../src/api/oauth-grants';
import { messagesByLocale } from '../src/i18n/messages';
import { ApiError, invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { AccountPage } from '../src/features/management/AccountPage';
import { browserNavigation } from '../src/app/navigation';
import { MembersPanel } from '../src/features/management/MembersPanel';
import { Identity, ManagementError, SecretDialog } from '../src/features/management/feedback';
import type { CurrentUser, PersonalAccessToken, ProjectInvitation, ProjectParticipant, ProjectParticipants, ProjectGrant } from '../src/api/auth';

vi.mock('../src/api/oauth-grants', () => ({ listOwnerGrants: vi.fn(), revokeOwnerGrant: vi.fn() }));

vi.mock('../src/api/project-settings', () => ({ getProject: vi.fn() }));

vi.mock('../src/api/auth', () => ({
  listTokens: vi.fn(), createToken: vi.fn(), revokeToken: vi.fn(), updateTokenExpiry: vi.fn(),
  getProjectAccess: vi.fn(), listMembers: vi.fn(), listInvitations: vi.fn(), createInvitation: vi.fn(), revokeInvitation: vi.fn(), setProjectGrant: vi.fn(), removeProjectGrant: vi.fn(),
}));

const localeRender = createLocaleRender('zh-CN');
const render: typeof localeRender = (ui, options) => localeRender(ui, { taskCache: { viewerId: user.id }, ...options });
let actorRole: 'admin' | 'member' = 'admin';

const user: CurrentUser = { personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, id: '00000000-0000-4000-8000-000000000201', name: 'Jianjun', email: 'a@example.com', emailVerified: true, avatarUrl: null };
const token: PersonalAccessToken = { id: 'token-a', name: 'MacBook', lastUsedAt: null, createdAt: '2026-10-22T12:00:00Z', expiresAt: '2099-10-22T12:00:00Z' };
const member = (id: string, role: 'admin' | 'member' = 'member'): ProjectParticipant => ({ inheritedFrom: null,
  userId: id, profile: { name: id === user.id ? user.name : id, email: `${id}@example.com`, avatarUrl: null }, effectiveRole: role,
  directGrant: { projectId: '00000000-0000-4000-8000-000000000101', userId: id, role, version: 9223372036854775806n, createdAt: '2026-10-22T12:00:00Z', updatedAt: '2026-10-22T12:00:00Z' },
});
const memberPage = (items: readonly ProjectParticipant[]): ProjectParticipants => {
  const actor = items.find((item) => item.userId === user.id);
  const role = actor?.effectiveRole ?? actorRole;
  const base = directAccessFixture('00000000-0000-4000-8000-000000000101', user.id, role);
  return { items, actorAccess: { ...base, directGrant: actor?.directGrant ?? null, teamRole: actor?.directGrant?.role === role ? null : role, canTransfer: actor?.directGrant?.role === role ? false : role === 'admin' } };
};
const invitation: ProjectInvitation = { id: 'invitation-a', projectId: '00000000-0000-4000-8000-000000000101', createdBy: user.id, createdAt: '2026-10-22T12:00:00Z', expiresAt: '2099-10-29T12:00:00Z', consumedAt: null, consumedBy: null, revokedAt: null };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const clickWhenReady = async (name: string) => {
  const button = await waitFor(() => {
    const current = screen.getByRole('button', { name });
    expect(current).not.toBeDisabled();
    return current;
  });
  fireEvent.click(button);
};
const dialogClick = async (name: string) => { const button = within(screen.getByRole('dialog')).getByRole('button', { name }); await waitFor(() => expect(button).not.toBeDisabled()); fireEvent.click(button); };
const account = () => render(<AccountPage user={user} onSignOut={vi.fn()} onIdentityMismatch={vi.fn()} />);
const members = (props: Partial<Parameters<typeof MembersPanel>[0]> = {}) => render(<MembersPanel projectId="00000000-0000-4000-8000-000000000101" user={user} onRemoved={vi.fn()} {...props} />);
const tokensTab = async () => { click('访问凭据'); await waitFor(() => expect(screen.queryByText('正在加载访问令牌…')).toBeNull()); };
const readyMembers = async () => { await waitFor(() => expect(screen.queryByText('正在加载项目成员…')).toBeNull()); };
const memberRoster = () => within(document.getElementById('members-title')!.closest('section')!);
const tokenForm = () => within(document.getElementById('create-token-form')!);
const createForm = async (name = 'new device', expiry: string | null = null) => {
  click('创建令牌');
  const form = tokenForm();
  fireEvent.change(form.getByLabelText(/令牌名称/), { target: { value: name } });
  if (expiry !== null) {
    fireEvent.change(form.getByLabelText('有效期'), { target: { value: 'custom' } });
    fireEvent.change(form.getByLabelText('到期日期和时间'), { target: { value: expiry } });
  }
  fireEvent.submit(document.getElementById('create-token-form')!);
};

beforeEach(() => {
  browserNavigation().dispose();
  history.replaceState(null, '', '/account');
  vi.resetAllMocks();
  vi.mocked(getProject).mockImplementation(async (id) => ({ id, name: "Very long project name" } as Project));
  actorRole = 'admin';
  vi.mocked(auth.getProjectAccess).mockImplementation(async (projectId) => directAccessFixture(projectId, user.id, actorRole));
  vi.mocked(auth.listTokens).mockResolvedValue([]);
  vi.mocked(grants.listOwnerGrants).mockResolvedValue([]);
  vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id, 'admin'), member('Alice')]));
  vi.mocked(auth.listInvitations).mockResolvedValue([]);
  vi.mocked(auth.revokeToken).mockResolvedValue();
  vi.mocked(auth.setProjectGrant).mockImplementation(async (projectId, userId, input) => { if (userId === user.id) actorRole = input.role; return { grant: member(userId, input.role).directGrant!, actorAccess: directAccessFixture(projectId, user.id, actorRole) }; });
  vi.mocked(auth.removeProjectGrant).mockImplementation(async (projectId, userId) => ({ projectId, userId, deleted: true, actorAccess: directAccessFixture(projectId, user.id, actorRole) }));
  vi.mocked(auth.revokeInvitation).mockResolvedValue();
});

describe('account credentials', () => {
  it.each(['https://example.test/avatar.png', 'data:image/png;base64,aW1hZ2U='])('passes the account avatar source to Identity: %s', (avatarUrl) => {
    render(<AccountPage user={{ ...user, avatarUrl }} onSignOut={vi.fn()} onIdentityMismatch={vi.fn()} />);
    const avatar = document.querySelector('.profile-info .management-avatar')!;
    const image = avatar.querySelector('img')!;
    expect(avatar).toHaveTextContent('JI'); expect(image).toHaveAttribute('src', avatarUrl); expect(image).not.toBeVisible();
    fireEvent.load(image);
    expect(image).toBeVisible(); expect(avatar).not.toHaveTextContent('JI');
    expect(screen.getByText(user.name!)).toBeVisible(); expect(screen.getByText(user.email!)).toBeVisible();
  });

  it('shows normalized profile, invokes sign out, loads safe errors and retries without representing failure as empty', async () => {
    const signOut = vi.fn();
    vi.mocked(auth.listTokens).mockRejectedValueOnce(new ApiError('server', 500, 'internal_error', 'safe-id'));
    render(<AccountPage user={user} onSignOut={signOut} onIdentityMismatch={vi.fn()} />);
    expect(auth.listTokens).not.toHaveBeenCalled();
    expect(screen.getByText(user.email!)).toBeInTheDocument();
    click('退出登录'); expect(signOut).toHaveBeenCalledOnce();
    await tokensTab();
    expect(screen.getByRole('alert')).toHaveTextContent('操作未能完成，请重试。请求 ID：safe-id');
    expect(screen.queryByText(/还没有访问令牌/)).toBeNull();
    click('重试'); await screen.findByText(/还没有访问令牌/);
  });

  it('keeps a loading state, marks expired tokens unusable, and cancels the creation dialog with focus recovery', async () => {
    const result = deferred<readonly PersonalAccessToken[]>();
    vi.mocked(auth.listTokens).mockReturnValue(result.promise);
    account(); click('访问凭据');
    expect(screen.getByText('正在加载访问令牌…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建令牌' })).toBeDisabled();
    await act(async () => result.resolve([{ ...token, expiresAt: '2000-01-01T00:00:00Z' }]));
    expect(screen.getByText('已过期')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /撤销令牌/ })).toBeNull();
    const opener = screen.getByRole('button', { name: '创建令牌' }); opener.focus(); fireEvent.click(opener);
    expect(tokenForm().getByLabelText(/令牌名称/)).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(opener).toHaveFocus();
  });

  it('validates code points and optional expiration, shows the PAT once, copies it, and warns on implicit close', async () => {
    vi.mocked(auth.createToken).mockResolvedValue({ ...token, token: 'pat-secret-once' });
    const copy = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    account(); await tokensTab();
    await createForm('😀'.repeat(101));
    expect(screen.getByRole('alert')).toHaveTextContent('1–100'); expect(auth.createToken).not.toHaveBeenCalled();
    fireEvent.change(tokenForm().getByLabelText(/令牌名称/), { target: { value: '😀'.repeat(100) } });
    fireEvent.change(tokenForm().getByLabelText('有效期'), { target: { value: 'custom' } });
    fireEvent.change(tokenForm().getByLabelText('到期日期和时间'), { target: { value: '2000-01-01T00:00' } });
    fireEvent.submit(document.getElementById('create-token-form')!); expect(auth.createToken).not.toHaveBeenCalled();
    fireEvent.change(tokenForm().getByLabelText('到期日期和时间'), { target: { value: '2099-10-22T12:00' } });
    fireEvent.submit(document.getElementById('create-token-form')!);
    await screen.findByRole('dialog', { name: '访问令牌已创建' });
    expect(auth.createToken).toHaveBeenCalledWith({ name: '😀'.repeat(100), expiresAt: new Date('2099-10-22T12:00').toISOString() }, expect.any(AbortSignal));
    expect(screen.getByLabelText('一次性访问令牌')).toHaveValue('pat-secret-once');
    await dialogClick('复制'); await screen.findByText('已复制。'); expect(copy).toHaveBeenCalledWith('pat-secret-once');
    fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.getByRole('alert')).toHaveTextContent('关闭后无法恢复');
    await dialogClick('返回保存'); expect(screen.queryByRole('alert')).toBeNull();
    await dialogClick('关闭对话框'); await dialogClick('确认已保存，关闭');
    expect(screen.queryByDisplayValue('pat-secret-once')).toBeNull(); expect(screen.getByText('MacBook')).toBeInTheDocument();
    click('个人资料'); await tokensTab(); expect(screen.queryByDisplayValue('pat-secret-once')).toBeNull();
  });

  it('retains selectable secret on clipboard rejection, then explicitly closes it', async () => {
    vi.mocked(auth.createToken).mockResolvedValue({ ...token, token: 'private-clipboard-secret' });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('clipboard secret details')) } });
    account(); await tokensTab(); await createForm();
    await screen.findByLabelText('一次性访问令牌'); await dialogClick('复制');
    await screen.findByText(/浏览器未允许自动复制/);
    const secret = screen.getByLabelText('一次性访问令牌') as HTMLTextAreaElement;
    expect(secret).toHaveFocus(); expect(secret.selectionStart).toBe(0); expect(secret.selectionEnd).toBe(secret.value.length);
    expect(screen.queryByText('clipboard secret details')).toBeNull();
    await dialogClick('我已保存，关闭'); expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps failed creation and revocation recoverable, disables duplicate submissions and reloads revoked metadata', async () => {
    vi.mocked(auth.listTokens).mockResolvedValueOnce([token]).mockResolvedValue([]);
    vi.mocked(auth.createToken).mockRejectedValue(new Error('sensitive PAT raw error'));
    account(); await tokensTab(); await createForm('device');
    await screen.findByRole('alert'); expect(screen.queryByText(/sensitive PAT/)).toBeNull();
    await dialogClick('取消'); click('撤销令牌 MacBook');
    const pending = deferred<void>(); vi.mocked(auth.revokeToken).mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new ApiError('server', 401));
    await dialogClick('撤销令牌'); expect(screen.getByRole('button', { name: '正在撤销…' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' }); fireEvent.keyDown(document, { key: 'Tab' }); expect(screen.getByRole('dialog')).toHaveFocus();
    await act(async () => pending.reject(new Error('internal raw secret')));
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('操作未能完成');
    await dialogClick('撤销令牌'); await screen.findByText('登录状态已失效，请重新登录。');
    vi.mocked(auth.revokeToken).mockResolvedValue(); await dialogClick('撤销令牌');
    await screen.findByText(/还没有访问令牌/); expect(screen.queryByRole('dialog')).toBeNull();
    expect(auth.revokeToken).toHaveBeenCalledWith(token.id, expect.any(AbortSignal));
  });

  it('rejects blank, NUL and malformed Unicode names while preserving an accepted name verbatim', async () => {
    vi.mocked(auth.createToken).mockResolvedValue({ ...token, token: 'new-secret' });
    account(); await tokensTab(); await createForm('   ');
    expect(auth.createToken).not.toHaveBeenCalled();
    for (const value of ['bad\0name', '\ud800']) {
      fireEvent.change(tokenForm().getByLabelText(/令牌名称/), { target: { value } });
      fireEvent.submit(document.getElementById('create-token-form')!);
      expect(auth.createToken).not.toHaveBeenCalled();
    }
    fireEvent.change(tokenForm().getByLabelText(/令牌名称/), { target: { value: '  device name  ' } });
    fireEvent.submit(document.getElementById('create-token-form')!);
    await screen.findByLabelText('一次性访问令牌');
    expect(auth.createToken).toHaveBeenCalledWith({ name: '  device name  ', expiresAt: null }, expect.any(AbortSignal));
  });

  it('aborts in-flight credential mutations when account state unmounts', async () => {
    const creation = deferred<auth.CreatedPersonalAccessToken>(); vi.mocked(auth.createToken).mockReturnValue(creation.promise);
    const view = account(); await tokensTab(); await createForm();
    expect(screen.getByRole('button', { name: '正在创建…' })).toBeDisabled();
    const signal = vi.mocked(auth.createToken).mock.calls[0]![1]; view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => creation.resolve({ ...token, token: 'must-not-reappear' }));
    expect(screen.queryByDisplayValue('must-not-reappear')).toBeNull();
  });

  it('switches an active form, pending request and secret dialog without losing user state or repeating requests', async () => {
    const pending = deferred<auth.CreatedPersonalAccessToken>(); vi.mocked(auth.createToken).mockReturnValue(pending.promise);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('clipboard denied')) } });
    const view = account(); await tokensTab(); await createForm('  unchanged name 😀  ', '2000-01-01T00:00');
    const en = messagesByLocale.en.auth.management;
    view.setLocale('en');
    expect(screen.getByRole('dialog', { name: en.account.createTitle })).toBeInTheDocument();
    expect(document.getElementById('token-name')).toHaveValue('  unchanged name 😀  ');
    expect(screen.getByLabelText(en.account.expiryDateLabel)).toHaveValue('2000-01-01T00:00'); expect(screen.getByRole('alert')).toHaveTextContent(en.account.validation);
    expect(auth.listTokens).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText(en.account.expiryDateLabel), { target: { value: '2099-10-22T12:31' } });
    fireEvent.submit(document.getElementById('create-token-form')!);
    view.setLocale('zh-CN');
    expect(screen.getByRole('button', { name: '正在创建…' })).toBeDisabled();
    expect(auth.createToken).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ ...token, token: 'unaltered-secret-value' }));
    await dialogClick('复制'); await screen.findByText(/浏览器未允许自动复制/);
    fireEvent.keyDown(document, { key: 'Escape' });
    view.setLocale('en');
    expect(screen.getByRole('dialog', { name: en.secret.tokenTitle })).toBeInTheDocument();
    expect(screen.getByLabelText(en.secret.tokenLabel)).toHaveValue('unaltered-secret-value');
    expect(screen.getByRole('alert')).toHaveTextContent(en.secret.tokenCloseWarning);
    expect(screen.getByRole('status')).toHaveTextContent(en.secret.copyFailed);
    expect(auth.createToken).toHaveBeenCalledWith({ name: '  unchanged name 😀  ', expiresAt: new Date('2099-10-22T12:31').toISOString() }, expect.any(AbortSignal));
    expect(auth.createToken).toHaveBeenCalledOnce();
    await dialogClick(en.secret.confirmClose); expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('aborts stale loads and never renders old account metadata after account replacement', async () => {
    const late = deferred<readonly PersonalAccessToken[]>(); vi.mocked(auth.listTokens).mockReturnValue(late.promise);
    const view = account(); click('访问凭据');
    const signal = vi.mocked(auth.listTokens).mock.calls[0]![0];
    view.rerender(<AccountPage user={{ ...user, id: '00000000-0000-4000-8000-000000000202', name: 'New account' }} onSignOut={vi.fn()} onIdentityMismatch={vi.fn()} />);
    expect(signal.aborted).toBe(true); expect(screen.getByText('New account')).toBeInTheDocument();
    await act(async () => late.resolve([token])); expect(screen.queryByText('MacBook')).toBeNull();
  });
});

describe('authoritative project management', () => {
  it('retries an invitation 403 once after access is confirmed and exposes a persistent failure', async () => {
    const forbidden = new ApiError('server', 403, 'forbidden');
    vi.mocked(auth.listInvitations).mockRejectedValue(forbidden);
    members();
    await screen.findByRole('alert'); await readyMembers();
    expect(auth.listInvitations).toHaveBeenCalledTimes(2);
    vi.mocked(auth.listInvitations).mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('Alice');
    expect(auth.listInvitations).toHaveBeenCalledTimes(3);
  });

  it('does not revoke the invitation originally shown after its state changes during a background read', async () => {
    vi.mocked(auth.listInvitations).mockResolvedValue([invitation]);
    members(); await readyMembers();
    const updated = deferred<readonly ProjectInvitation[]>();
    vi.mocked(auth.listInvitations).mockReturnValueOnce(updated.promise);
    click('撤销邀请 invitation-a');
    const dialog = screen.getByRole('dialog');
    await waitForState(() => expect(auth.listInvitations).toHaveBeenCalledTimes(2));
    fireEvent.click(within(dialog).getByRole('button', { name: '撤销邀请' }));
    expect(auth.revokeInvitation).not.toHaveBeenCalled();
    await act(async () => updated.resolve([{ ...invitation, consumedAt: '2026-10-28T00:00:00Z', consumedBy: 'Alice' }]));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toBeVisible());
    expect(auth.revokeInvitation).not.toHaveBeenCalled();
  });

  it('keeps the existing roster and invitations during an active route recovery read', async () => {
    vi.mocked(auth.listInvitations).mockResolvedValue([invitation]);
    const props = { projectId: '00000000-0000-4000-8000-000000000101', user, onRemoved: vi.fn() };
    const view = render(<MembersPanel {...props} active onRoute />); await readyMembers();
    const row = screen.getByText('Alice').closest('.grant-row');
    const revoke = screen.getByRole('button', { name: '撤销邀请 invitation-a' });
    view.rerender(<MembersPanel {...props} active={false} onRoute />);
    const roster = deferred<auth.ProjectParticipants>();
    vi.mocked(auth.listMembers).mockReturnValueOnce(roster.promise);
    const reads = vi.mocked(auth.listMembers).mock.calls.length;
    view.rerender(<MembersPanel {...props} active onRoute />);
    await waitForState(() => expect(auth.listMembers).toHaveBeenCalledTimes(reads + 1));
    expect(screen.getByText('Alice').closest('.grant-row')).toBe(row);
    expect(screen.getByRole('button', { name: '撤销邀请 invitation-a' })).toBe(revoke);
    expect(screen.queryByText('正在加载项目成员…')).toBeNull();
    await act(async () => roster.resolve(memberPage([member(user.id, 'admin'), member('Alice')])));
    await waitFor(() => expect(screen.getByText('Alice').closest('.grant-row')).toBe(row));
  });

  it('cancels a not-yet-dispatched grant when the user leaves the route', async () => {
    const guard = vi.fn();
    const props = { projectId: '00000000-0000-4000-8000-000000000101', user, onRemoved: vi.fn(), onGuardChange: guard };
    const view = render(<MembersPanel {...props} active onRoute />); await readyMembers();
    const check = deferred<auth.ProjectAccess>();
    vi.mocked(auth.getProjectAccess).mockReturnValueOnce(check.promise);
    const reads = vi.mocked(auth.getProjectAccess).mock.calls.length;
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    await waitForState(() => expect(auth.getProjectAccess).toHaveBeenCalledTimes(reads + 1));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存角色' }));
    expect(guard).toHaveBeenLastCalledWith(true);
    view.rerender(<MembersPanel {...props} active={false} onRoute={false} />);
    await waitForState(() => expect(guard).toHaveBeenLastCalledWith(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(<MembersPanel {...props} active onRoute />);
    await act(async () => check.resolve(directAccessFixture(props.projectId, user.id, 'admin')));
    await readyMembers();
    expect(auth.setProjectGrant).not.toHaveBeenCalled();
  });

  it('ignores a superseded roster 404 and makes a waiting grant follow the replacement read', async () => {
    const unavailable = vi.fn();
    members({ onUnavailable: unavailable }); await readyMembers();
    const initial = vi.mocked(auth.listMembers).mock.calls.length;
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    const dialog = screen.getByRole('dialog');
    await waitForState(() => expect(auth.listMembers).toHaveBeenCalledTimes(initial + 1));
    await waitForState(() => expect(auth.listInvitations).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    const stale = deferred<auth.ProjectParticipants>(), replacement = deferred<auth.ProjectParticipants>();
    vi.mocked(auth.listMembers).mockReturnValueOnce(stale.promise).mockReturnValueOnce(replacement.promise);
    fireEvent(window, new Event('focus'));
    await waitForState(() => expect(auth.listMembers).toHaveBeenCalledTimes(initial + 2));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存角色' }));
    fireEvent(window, new Event('focus'));
    await waitForState(() => expect(auth.listMembers).toHaveBeenCalledTimes(initial + 3));
    await act(async () => stale.reject(new ApiError('server', 404, 'not_found')));
    expect(screen.getByText('Alice')).toBeVisible(); expect(unavailable).not.toHaveBeenCalled();
    expect(auth.setProjectGrant).not.toHaveBeenCalled();
    await act(async () => replacement.resolve(memberPage([member(user.id, 'admin'), member('Alice')])));
    await waitForState(() => expect(auth.setProjectGrant).toHaveBeenCalledOnce());
    expect(unavailable).not.toHaveBeenCalled();
  });

  it('refreshes changes observed during a rejected in-flight grant', async () => {
    const write = deferred<auth.ProjectGrantResult>();
    vi.mocked(auth.setProjectGrant).mockReturnValueOnce(write.promise);
    members(); await readyMembers();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    await dialogClick('保存角色');
    await waitForState(() => expect(auth.setProjectGrant).toHaveBeenCalledOnce());
    const reads = vi.mocked(auth.listMembers).mock.calls.length;
    const accessReads = vi.mocked(auth.getProjectAccess).mock.calls.length;
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id, 'admin'), { ...member('Alice'), profile: { ...member('Alice').profile, name: 'Alice Updated' } }]));
    fireEvent(window, new Event('focus'));
    await waitForState(() => expect(vi.mocked(auth.getProjectAccess).mock.calls.length).toBeGreaterThan(accessReads));
    expect(auth.listMembers).toHaveBeenCalledTimes(reads);
    await act(async () => write.reject(new ApiError('server', 422, 'invalid_input')));
    expect(await screen.findByText('Alice Updated')).toBeVisible();
    expect(auth.setProjectGrant).toHaveBeenCalledOnce();
  });

  it.each(['same', 'inherited', 'read error'] as const)('waits for the background roster and invitations before submitting (%s)', async (outcome) => {
    vi.mocked(auth.listInvitations).mockResolvedValue([invitation]);
    members(); await readyMembers();
    const initialReads = vi.mocked(auth.listMembers).mock.calls.length;
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    const dialog = screen.getByRole('dialog');
    await waitForState(() => expect(auth.listMembers).toHaveBeenCalledTimes(initialReads + 1));
    await waitForState(() => expect(auth.listInvitations).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    const row = screen.getByText('Alice').closest('.grant-row');
    const confirm = within(dialog).getByRole('button', { name: '保存角色' });
    confirm.focus();
    const accessRead = deferred<auth.ProjectAccess>(), roster = deferred<auth.ProjectParticipants>(), invites = deferred<readonly ProjectInvitation[]>();
    vi.mocked(auth.getProjectAccess).mockReturnValueOnce(accessRead.promise);
    vi.mocked(auth.listMembers).mockReturnValueOnce(roster.promise);
    vi.mocked(auth.listInvitations).mockReturnValueOnce(invites.promise);
    const priorRoster = vi.mocked(auth.listMembers).mock.calls.length;
    fireEvent(window, new Event('focus'));
    expect(screen.getByRole('dialog')).toBe(dialog); expect(confirm).toHaveFocus();
    expect(screen.getByText('Alice').closest('.grant-row')).toBe(row);
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(auth.setProjectGrant).not.toHaveBeenCalled();
    await act(async () => accessRead.resolve(directAccessFixture('00000000-0000-4000-8000-000000000101', user.id, 'admin')));
    await waitForState(() => expect(auth.listMembers).toHaveBeenCalledTimes(priorRoster + 1));
    expect(screen.getByText('Alice').closest('.grant-row')).toBe(row);
    expect(auth.setProjectGrant).not.toHaveBeenCalled();
    if (outcome === 'read error') {
      await act(async () => roster.reject(new Error('offline')));
      await waitFor(() => expect(within(dialog).getByRole('alert')).toBeVisible());
      expect(auth.setProjectGrant).not.toHaveBeenCalled();
      expect(screen.getByText('Alice').closest('.grant-row')).toBe(row);
      return;
    }
    const alice = outcome === 'inherited' ? { ...member('Alice'), inheritedFrom: { team: user.personalTeam, role: 'admin' as const }, effectiveRole: 'admin' as const } : { ...member('Alice'), profile: { ...member('Alice').profile } };
    await act(async () => roster.resolve(memberPage([{ ...member(user.id, 'admin') }, alice])));
    await waitForState(() => expect(auth.listInvitations).toHaveBeenCalledTimes(3));
    expect(screen.getByText('Alice').closest('.grant-row')).toBe(row);
    expect(auth.setProjectGrant).not.toHaveBeenCalled();
    await act(async () => invites.resolve([{ ...invitation }]));
    if (outcome === 'same') await waitForState(() => expect(auth.setProjectGrant).toHaveBeenCalledOnce());
    else { await waitFor(() => expect(within(dialog).getByRole('alert')).toBeVisible()); expect(auth.setProjectGrant).not.toHaveBeenCalled(); expect(row).toHaveTextContent('管理员'); }
  });

  it.each(['same', 'demoted', 'ownership'] as const)('retains the roster and dialog while waiting to submit a grant after %s access', async (outcome) => {
    members(); await readyMembers();
    const row = screen.getByText('Alice').closest('.grant-row');
    const select = memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' });
    const check = deferred<auth.ProjectAccess>();
    const reads = vi.mocked(auth.getProjectAccess).mock.calls.length;
    vi.mocked(auth.getProjectAccess).mockReturnValueOnce(check.promise);
    fireEvent.change(select, { target: { value: 'admin' } });
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: '保存角色' });
    confirm.focus();
    await waitForState(() => expect(auth.getProjectAccess).toHaveBeenCalledTimes(reads + 1));
    expect(screen.getByText('Alice').closest('.grant-row')).toBe(row);
    expect(screen.getByRole('dialog')).toBe(dialog); expect(confirm).toHaveFocus(); expect(confirm).toBeEnabled();
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(auth.setProjectGrant).not.toHaveBeenCalled();
    const previous = directAccessFixture('00000000-0000-4000-8000-000000000101', user.id, 'admin');
    const fresh = outcome === 'demoted' ? directAccessFixture(previous.projectId, user.id, 'member') : outcome === 'ownership' ? { ...previous, ownership: { ...previous.ownership, version: previous.ownership.version + 1n } } : { ...previous, ownership: { ...previous.ownership } };
    await act(async () => check.resolve(fresh));
    if (outcome === 'same') await waitForState(() => expect(auth.setProjectGrant).toHaveBeenCalledOnce());
    else { await waitFor(() => expect(confirm).not.toHaveTextContent('正在提交')); expect(auth.setProjectGrant).not.toHaveBeenCalled(); }
  });

  it('settles a cancelled preparation without dispatch even while the shared access read is still pending', async () => {
    const check = deferred<auth.ProjectAccess>();
    const guard = vi.fn();
    const props = { projectId: '00000000-0000-4000-8000-000000000101', user, onRemoved: vi.fn(), onGuardChange: guard };
    const view = render(<MembersPanel {...props} active onRoute />); await readyMembers();
    const reads = vi.mocked(auth.getProjectAccess).mock.calls.length;
    vi.mocked(auth.getProjectAccess).mockReturnValueOnce(check.promise);
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    await waitForState(() => expect(auth.getProjectAccess).toHaveBeenCalledTimes(reads + 1));
    guard.mockClear();
    await dialogClick('保存角色');
    expect(guard).toHaveBeenCalledWith(true);
    view.rerender(<MembersPanel {...props} active onRoute={false} />);
    await waitFor(() => expect(guard).toHaveBeenLastCalledWith(false));
    expect(auth.setProjectGrant).not.toHaveBeenCalled();
    await act(async () => check.reject(new Error('late access read failure')));
    expect(auth.setProjectGrant).not.toHaveBeenCalled();
  });

  it('reads regular member state without requesting administrator invitations', async () => {
    actorRole = 'member';
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id), member('Alice', 'admin')]));
    members({ projectName: 'Very long project name' }); await readyMembers();
    expect(screen.getByText(/成员与邀请由项目管理员管理/)).toBeInTheDocument();
    expect(auth.listInvitations).not.toHaveBeenCalled(); expect(screen.queryByRole('combobox')).toBeNull(); expect(screen.queryByRole('button', { name: '邀请成员' })).toBeNull();
    expect(screen.getByText('Very long project name · 管理协作成员与加入邀请')).toBeInTheDocument();
  });

  it('allows the last direct admin to change grants and submits the exact observed int64 version on confirmed promotion', async () => {
    const change = vi.fn(); members({ onMembershipChange: change }); await readyMembers();
    expect(memberRoster().getByRole('combobox', { name: 'Jianjun 的单独授权' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: '移除 Jianjun 的单独授权' })).not.toBeDisabled();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    expect(auth.setProjectGrant).not.toHaveBeenCalled();
    await dialogClick('取消'); expect(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' })).toHaveValue('member');
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    await dialogClick('保存角色'); await waitForState(() => expect(change).toHaveBeenCalledOnce()); await readyMembers();
    expect(auth.setProjectGrant).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000101', 'Alice', { version: 9223372036854775806n, role: 'admin', expectedUserId: user.id }, expect.any(AbortSignal), expect.any(Function), expect.any(Function));
  });

  it.each([403, 409])('reloads authoritative role after %s, hides privileged actions and does not repeat the mutation', async (status) => {
    vi.mocked(auth.listMembers).mockImplementation(async () => actorRole === 'admin' ? memberPage([member(user.id, 'admin'), member('Alice')]) : memberPage([member(user.id), member('Alice', 'admin')]));
    vi.mocked(auth.setProjectGrant).mockImplementation(async (_project, _user, _input, _signal, _mismatch, dispatched) => { dispatched?.(); actorRole = 'member'; throw new ApiError('server', status, status === 409 ? 'conflict' : 'forbidden'); });
    members(); await readyMembers();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } }); await dialogClick('保存角色');
    await screen.findByText(/成员与邀请由项目管理员管理/);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('combobox')).toBeNull();
    expect(auth.listInvitations).toHaveBeenCalledTimes(2); expect(auth.setProjectGrant).toHaveBeenCalledOnce(); expect(auth.listMembers).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('status')).toHaveTextContent(status === 409 ? '成员状态已变化' : '项目权限已变化');
  });

  it.each([403, 404, 409])('retains a known %s refusal across a paused subsequent submission until an authoritative read', async (status) => {
    const result = deferred<auth.ProjectGrantResult>();
    vi.mocked(auth.setProjectGrant).mockImplementationOnce(async (_project, _user, _input, _signal, _mismatch, dispatched) => { dispatched?.(); return result.promise; });
    members(); await readyMembers();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    await dialogClick('保存角色');
    await waitForState(() => expect(auth.setProjectGrant).toHaveBeenCalledOnce());
    const reads = vi.mocked(auth.listMembers).mock.calls.length;
    const resume = pauseAuthRequests();
    try {
      await act(async () => result.reject(new ApiError('server', status, status === 409 ? 'conflict' : 'forbidden', 'refusal-id')));
      await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' })).toBeEnabled());
      expect(screen.getByRole('alert')).toHaveTextContent('refusal-id');
      expect(screen.queryByText(/服务端未确认这次成员变更/)).toBeNull();
      await dialogClick('取消');
      await clickWhenReady('邀请成员');
      expect(within(screen.getByRole('dialog')).getByRole('button', { name: '创建邀请链接' })).toBeDisabled();
      expect(auth.createInvitation).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('refusal-id');
      expect(auth.listMembers).toHaveBeenCalledTimes(reads);
      resume();
      await waitForState(() => expect(vi.mocked(auth.listMembers).mock.calls.length).toBeGreaterThan(reads));
      await waitFor(() => expect(screen.queryByText('refusal-id')).toBeNull());
      expect(screen.getByRole('status')).toHaveTextContent(status === 409 ? '成员状态已变化' : '项目权限已变化');
      expect(screen.getByRole('dialog')).toHaveTextContent('创建邀请链接');
      expect(auth.setProjectGrant).toHaveBeenCalledOnce();
      expect(auth.createInvitation).not.toHaveBeenCalled();
    } finally { resume(); }
  });

  it('localizes a conflict notice and the current role without reloading network state on language change', async () => {
    vi.mocked(auth.listMembers).mockImplementation(async () => actorRole === 'admin' ? memberPage([member(user.id, 'admin'), member('Alice')]) : memberPage([member(user.id), member('Alice', 'admin')]));
    vi.mocked(auth.setProjectGrant).mockImplementation(async (_project, _user, _input, _signal, _mismatch, dispatched) => { dispatched?.(); actorRole = 'member'; throw new ApiError('server', 409, 'conflict'); });
    const view = members(); await readyMembers();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    const en = messagesByLocale.en.auth.management;
    view.setLocale('en');
    expect(screen.getByRole('dialog', { name: en.members.roleTitle({ name: 'Alice' }) })).toBeInTheDocument();
    await dialogClick(en.members.saveRole);
    await screen.findByText(en.members.memberNotice);
    expect(screen.getByRole('status')).toHaveTextContent(en.members.notice.conflictReloaded);
    expect(auth.listMembers).toHaveBeenCalledTimes(3); expect(auth.listInvitations).toHaveBeenCalledTimes(2); expect(auth.setProjectGrant).toHaveBeenCalledOnce();
  });

  it('reloads after self-demotion and gives up its admin actions immediately', async () => {
    vi.mocked(auth.listMembers).mockResolvedValueOnce(memberPage([member(user.id, 'admin'), member('Alice', 'admin')])).mockResolvedValue(memberPage([member(user.id), member('Alice', 'admin')]));
    members(); await readyMembers();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Jianjun 的单独授权' }), { target: { value: 'member' } });
    expect(screen.getByRole('dialog')).toHaveTextContent('单独授权：管理员 → 成员'); await dialogClick('保存角色');
    await screen.findByText(/成员与邀请由项目管理员管理/); expect(screen.queryByRole('button', { name: '邀请成员' })).toBeNull();
  });

  it('confirms and removes another member with its observed version, then navigates after explicit self-removal', async () => {
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id, 'admin'), member('Alice', 'admin')]));
    const removed = vi.fn(); members({ onRemoved: removed }); await readyMembers();
    click('移除 Alice 的单独授权'); expect(screen.getByText(/这会撤销对方的项目单独授权/)).toBeInTheDocument(); await dialogClick('移除授权');
    await waitForState(() => expect(auth.removeProjectGrant).toHaveBeenCalledOnce()); await readyMembers();
    expect(auth.removeProjectGrant).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000101', 'Alice', { version: 9223372036854775806n, expectedUserId: user.id }, expect.any(AbortSignal), expect.any(Function), expect.any(Function)); expect(removed).not.toHaveBeenCalled();
    vi.mocked(auth.removeProjectGrant).mockImplementation(async (projectId, userId) => { vi.mocked(auth.getProjectAccess).mockRejectedValue(new ApiError('server', 404, 'not_found')); return { projectId, userId, deleted: true, actorAccess: null }; });
    await screen.findByText('已移除 Alice 的单独授权。'); await readyMembers();
    await clickWhenReady('移除 Jianjun 的单独授权'); expect(screen.getByText(/撤销你的项目单独授权/)).toBeInTheDocument(); await dialogClick('移除授权');
    await screen.findByText('此变更使你失去了项目访问权限。'); expect(removed).not.toHaveBeenCalled(); click('返回项目'); expect(removed).toHaveBeenCalledOnce();
  });

  it('retains inherited administrator access after self-demotion', async () => {
    const changed = { ...member(user.id, 'member'), effectiveRole: 'admin' as const };
    vi.mocked(auth.setProjectGrant).mockImplementation(async () => {
      vi.mocked(auth.listMembers).mockResolvedValue(memberPage([changed, member('Alice')]));
      vi.mocked(auth.getProjectAccess).mockResolvedValue({ ...directAccessFixture('00000000-0000-4000-8000-000000000101', user.id, 'admin'), teamRole: 'admin', canTransfer: true, directGrant: changed.directGrant });
      return { grant: changed.directGrant!, actorAccess: { ...directAccessFixture('00000000-0000-4000-8000-000000000101', user.id, 'admin'), teamRole: 'admin', canTransfer: true, directGrant: changed.directGrant } };
    });
    members(); await readyMembers();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Jianjun 的单独授权' }), { target: { value: 'member' } });
    await dialogClick('保存角色');
    await waitFor(() => expect(memberRoster().getByRole('combobox', { name: 'Jianjun 的单独授权' })).toHaveValue('member'));
    expect(screen.getByRole('button', { name: '邀请成员' })).not.toBeDisabled();
    expect(auth.setProjectGrant).toHaveBeenCalledOnce();
  });

  it.each(['member', 'admin'] as const)('retains inherited %s access after removing its own direct grant', async (effectiveRole) => {
    const removed = vi.fn();
    vi.mocked(auth.removeProjectGrant).mockImplementation(async (projectId, userId) => {
      vi.mocked(auth.listMembers).mockResolvedValue(memberPage([{ ...member(user.id, effectiveRole), directGrant: null }, member('Alice')]));
      const actorAccess = { ...directAccessFixture(projectId, user.id, effectiveRole), teamRole: effectiveRole, canTransfer: effectiveRole === 'admin', directGrant: null };
      vi.mocked(auth.getProjectAccess).mockResolvedValue(actorAccess);
      return { projectId, userId, deleted: true, actorAccess };
    });
    members({ onRemoved: removed }); await readyMembers();
    click('移除 Jianjun 的单独授权'); await dialogClick('移除授权');
    await screen.findByText(/已移除 Jianjun 的单独授权/); await readyMembers();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Jianjun')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '移除 Jianjun 的单独授权' })).toBeNull();
    if (effectiveRole === 'admin') expect(memberRoster().getByRole('combobox', { name: 'Jianjun 的单独授权' })).toHaveValue('');
    else expect(screen.queryByRole('combobox', { name: 'Jianjun 的单独授权' })).toBeNull();
    if (effectiveRole === 'admin') expect(screen.getByRole('button', { name: '邀请成员' })).not.toBeDisabled();
    else expect(screen.queryByRole('button', { name: '邀请成员' })).toBeNull();
    expect(removed).not.toHaveBeenCalled(); expect(auth.removeProjectGrant).toHaveBeenCalledOnce();
  });

  it('creates a seven-day once-only invitation and revokes it without retaining its link', async () => {
    let catalogue: readonly ProjectInvitation[] = [];
    vi.mocked(auth.listInvitations).mockImplementation(async () => catalogue);
    vi.mocked(auth.createInvitation).mockImplementation(async () => { catalogue = [invitation]; return { ...invitation, link: 'https://daynight.test/invitations#once-secret' }; });
    vi.mocked(auth.revokeInvitation).mockImplementation(async (_projectId, invitationId) => { catalogue = catalogue.filter((item) => item.id !== invitationId); });
    members(); await readyMembers(); expect(screen.getByText(/还没有有效邀请/)).toBeInTheDocument();
    click('邀请成员'); expect(screen.getByText('7 天后到期 · 单次使用 · 加入角色：成员')).toBeInTheDocument(); await dialogClick('创建邀请链接');
    await screen.findByLabelText('一次性邀请链接'); expect(auth.createInvitation).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000101', user.id, expect.any(AbortSignal), expect.any(Function), expect.any(Function));
    expect(screen.getByLabelText('一次性邀请链接')).toHaveValue('https://daynight.test/invitations#once-secret'); await dialogClick('我已保存，关闭');
    expect(screen.queryByDisplayValue(/once-secret/)).toBeNull();
    await clickWhenReady('撤销邀请 invitation-a');
    expect(screen.getByText(/这个邀请链接将立即失效/)).toBeInTheDocument(); await dialogClick('撤销邀请');
    await screen.findByText(/还没有有效邀请/); expect(auth.revokeInvitation).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000101', 'invitation-a', user.id, expect.any(AbortSignal), expect.any(Function), expect.any(Function));
  });

  it('keeps a confirmed revocation non-repeatable when a later operation supersedes its pending publication', async () => {
    const revoked = deferred<void>();
    vi.mocked(auth.listInvitations).mockResolvedValue([invitation]);
    vi.mocked(auth.revokeInvitation).mockImplementationOnce(async (_project, _id, _user, _signal, _mismatch, dispatched) => { dispatched?.(); return revoked.promise; });
    vi.mocked(auth.createInvitation).mockImplementation(async (_project, _user, _signal, _mismatch, dispatched) => { dispatched?.(); return { ...invitation, id: 'invitation-b', link: 'https://daynight.test/invitations#next' }; });
    members(); await readyMembers();
    await clickWhenReady('撤销邀请 invitation-a'); await dialogClick('撤销邀请');
    await waitForState(() => expect(auth.revokeInvitation).toHaveBeenCalledOnce());
    let resume = () => {};
    await act(async () => { revoked.resolve(); await Promise.resolve(); await Promise.resolve(); resume = pauseAuthRequests(); });
    try {
      await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' })).toBeEnabled());
      await dialogClick('取消');
      await clickWhenReady('邀请成员'); await dialogClick('创建邀请链接');
      await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' })).toBeEnabled());
      expect(auth.createInvitation).not.toHaveBeenCalled();
      resume();
      await dialogClick('创建邀请链接');
      await screen.findByDisplayValue('https://daynight.test/invitations#next');
      await dialogClick('我已保存，关闭');
      await waitFor(() => {
        expect(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' })).toBeEnabled();
        expect(screen.getByRole('button', { name: '撤销邀请 invitation-a' })).toBeDisabled();
      });
      expect(auth.revokeInvitation).toHaveBeenCalledOnce();
    } finally { resume(); }
  });

  it('retains a confirmed invitation secret across navigation until explicitly closed', async () => {
    const link = 'https://daynight.test/invitations#once-secret';
    vi.mocked(auth.createInvitation).mockResolvedValue({ ...invitation, link });
    const retain = vi.fn();
    const props = { projectId: '00000000-0000-4000-8000-000000000101', user, onRemoved: vi.fn(), onGuardChange: retain };
    const view = render(<MembersPanel {...props} active onRoute />); await readyMembers();
    await clickWhenReady('邀请成员'); await dialogClick('创建邀请链接');
    await screen.findByDisplayValue(link);
    await waitFor(() => expect(retain).toHaveBeenLastCalledWith(true));
    view.rerender(<MembersPanel {...props} active={false} onRoute={false} />);
    expect(screen.getByDisplayValue(link)).not.toBeVisible();
    view.rerender(<MembersPanel {...props} active onRoute />);
    expect(await screen.findByDisplayValue(link)).toBeVisible();
    await dialogClick('我已保存，关闭');
    expect(screen.queryByDisplayValue(link)).toBeNull();
    await waitFor(() => expect(retain).toHaveBeenLastCalledWith(false));
    expect(auth.createInvitation).toHaveBeenCalledOnce();
  });

  it('keeps an already revealed invitation secret visible and focused while identity and access are checked', async () => {
    const link = 'https://daynight.test/invitations#once-secret';
    vi.mocked(auth.createInvitation).mockResolvedValue({ ...invitation, link });
    members(); await readyMembers();
    await clickWhenReady('邀请成员'); await dialogClick('创建邀请链接');
    const field = await screen.findByLabelText('一次性邀请链接') as HTMLTextAreaElement;
    await waitFor(() => expect(field).toBeVisible());
    field.focus(); field.setSelectionRange(2, 8);
    const dialog = screen.getByRole('dialog');
    const resume = pauseAuthRequests();
    fireEvent(window, new Event('focus'));
    expect(screen.getByRole('dialog')).toBe(dialog); expect(field).toBeVisible();
    expect(document.activeElement).toBe(field); expect(field.selectionStart).toBe(2); expect(field.selectionEnd).toBe(8);
    resume();
    await waitFor(() => expect(screen.getByRole('dialog')).toBe(dialog));
    expect(field).toBeVisible();
  });

  it('holds a new invitation secret through identity and retains it after confirmed role loss', async () => {
    const created = deferred<auth.CreatedProjectInvitation>();
    const permission = deferred<auth.ProjectAccess>();
    const link = 'https://daynight.test/invitations#once-secret';
    vi.mocked(auth.createInvitation).mockImplementationOnce(async (_project, _user, _signal, _mismatch, dispatched) => { dispatched?.(); return created.promise; });
    members(); await readyMembers();
    await clickWhenReady('邀请成员'); await dialogClick('创建邀请链接');
    await waitForState(() => expect(auth.createInvitation).toHaveBeenCalledOnce());
    const resume = pauseAuthRequests();
    const priorReads = vi.mocked(auth.getProjectAccess).mock.calls.length;
    vi.mocked(auth.getProjectAccess).mockReturnValueOnce(permission.promise);
    fireEvent(window, new Event('focus'));
    await act(async () => created.resolve({ ...invitation, link }));
    expect(screen.queryByDisplayValue(link)).toBeNull();
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' })).toBeEnabled());
    expect(vi.mocked(auth.getProjectAccess).mock.calls.length).toBe(priorReads);
    resume();
    await waitForState(() => expect(vi.mocked(auth.getProjectAccess).mock.calls.length).toBeGreaterThan(priorReads));
    expect(await screen.findByDisplayValue(link)).toBeVisible();
    actorRole = 'member';
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id), member('Alice')]));
    await act(async () => permission.resolve(directAccessFixture('00000000-0000-4000-8000-000000000101', user.id, 'member')));
    await waitFor(() => expect(screen.queryByRole('button', { name: '邀请成员' })).toBeNull());
    expect(screen.getByDisplayValue(link)).toBeVisible();
    expect(screen.queryByText(invitation.id)).toBeNull();
    actorRole = 'admin';
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id, 'admin'), member('Alice')]));
    fireEvent(window, new Event('focus'));
    expect(await screen.findByDisplayValue(link)).toBeVisible();
    expect(auth.createInvitation).toHaveBeenCalledOnce();
  });

  it.each(['member', 'denied'] as const)('preserves or clears a revealed secret according to confirmed %s access', async (outcome) => {
    const link = 'https://daynight.test/invitations#once-secret';
    vi.mocked(auth.createInvitation).mockResolvedValue({ ...invitation, link });
    members(); await readyMembers();
    await clickWhenReady('邀请成员'); await dialogClick('创建邀请链接');
    const field = await screen.findByDisplayValue(link) as HTMLTextAreaElement;
    field.focus(); field.setSelectionRange(2, 8);
    if (outcome === 'member') {
      actorRole = 'member';
      vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id), member('Alice')]));
    } else vi.mocked(auth.getProjectAccess).mockRejectedValue(new ApiError('server', 404, 'not_found'));
    fireEvent(window, new Event('focus'));
    if (outcome === 'member') await waitFor(() => expect(screen.queryByRole('button', { name: '邀请成员' })).toBeNull());
    else await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('项目不存在'));
    if (outcome === 'member') {
      expect(screen.getByDisplayValue(link)).toBe(field); expect(field).toBeVisible();
      expect(document.activeElement).toBe(field); expect(field.selectionStart).toBe(2); expect(field.selectionEnd).toBe(8);
    } else expect(screen.queryByDisplayValue(link)).toBeNull();
    expect(auth.createInvitation).toHaveBeenCalledOnce();
  });

  it('does not reveal a held secret after identity invalidation', async () => {
    const created = deferred<auth.CreatedProjectInvitation>();
    const link = 'https://daynight.test/invitations#once-secret';
    vi.mocked(auth.createInvitation).mockImplementationOnce(async (_project, _user, _signal, _mismatch, dispatched) => { dispatched?.(); return created.promise; });
    members(); await readyMembers();
    await clickWhenReady('邀请成员'); await dialogClick('创建邀请链接');
    await waitForState(() => expect(auth.createInvitation).toHaveBeenCalledOnce());
    const resume = pauseAuthRequests();
    await act(async () => created.resolve({ ...invitation, link }));
    expect(screen.queryByDisplayValue(link)).toBeNull();
    act(() => invalidateAuthRequests()); resume();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByDisplayValue(link)).toBeNull();
  });

  it('does not publish an in-flight invitation list after a fresh permission downgrade', async () => {
    const listing = deferred<readonly ProjectInvitation[]>(), permission = deferred<auth.ProjectAccess>();
    vi.mocked(auth.listInvitations).mockReturnValueOnce(listing.promise);
    members(); await waitForState(() => expect(auth.listInvitations).toHaveBeenCalledOnce());
    const resume = pauseAuthRequests();
    const priorReads = vi.mocked(auth.getProjectAccess).mock.calls.length;
    vi.mocked(auth.getProjectAccess).mockReturnValueOnce(permission.promise);
    fireEvent(window, new Event('focus'));
    await act(async () => listing.resolve([invitation]));
    expect(screen.queryByText(invitation.id)).toBeNull();
    resume();
    await waitForState(() => expect(vi.mocked(auth.getProjectAccess).mock.calls.length).toBeGreaterThan(priorReads));
    expect(screen.queryByText(invitation.id)).toBeNull();
    actorRole = 'member';
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id), member('Alice')]));
    await act(async () => permission.resolve(directAccessFixture('00000000-0000-4000-8000-000000000101', user.id, 'member')));
    await waitFor(() => expect(screen.queryByRole('button', { name: '邀请成员' })).toBeNull());
    expect(screen.queryByText(invitation.id)).toBeNull();
  });

  it('retains a confirmed invitation after leaving and returning with downgraded access', async () => {
    const created = deferred<auth.CreatedProjectInvitation>();
    const link = 'https://daynight.test/invitations#once-secret';
    vi.mocked(auth.createInvitation).mockImplementationOnce(async (_project, _user, _signal, _mismatch, dispatched) => { dispatched?.(); return created.promise; });
    const props = { projectId: '00000000-0000-4000-8000-000000000101', projectName: 'Private', user, onRemoved: vi.fn() };
    const view = render(<MembersPanel {...props} active onRoute />); await readyMembers();
    await clickWhenReady('邀请成员'); await dialogClick('创建邀请链接');
    await waitForState(() => expect(auth.createInvitation).toHaveBeenCalledOnce());
    view.rerender(<MembersPanel {...props} active={false} onRoute={false} />);
    await act(async () => created.resolve({ ...invitation, link }));
    expect(screen.queryByDisplayValue(link)).toBeNull();
    actorRole = 'member';
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id), member('Alice')]));
    view.rerender(<MembersPanel {...props} active onRoute />);
    await waitFor(() => expect(screen.queryByRole('button', { name: '邀请成员' })).toBeNull());
    await clickWhenReady('查看邀请链接');
    expect(await screen.findByDisplayValue(link)).toBeVisible();
    expect(screen.queryByText(invitation.id)).toBeNull();
    expect(auth.createInvitation).toHaveBeenCalledOnce();
  });

  it('discards a retained invitation secret when its identity owner unmounts', async () => {
    const link = 'https://daynight.test/invitations#once-secret';
    vi.mocked(auth.createInvitation).mockResolvedValue({ ...invitation, link });
    const props = { projectId: '00000000-0000-4000-8000-000000000101', user, onRemoved: vi.fn() };
    const view = render(<MembersPanel {...props} active onRoute />); await readyMembers();
    await clickWhenReady('邀请成员'); await dialogClick('创建邀请链接');
    await screen.findByDisplayValue(link);
    view.rerender(<MembersPanel {...props} active={false} onRoute={false} />);
    view.unmount();
    expect(screen.queryByDisplayValue(link)).toBeNull();
    members(); await readyMembers();
    expect(screen.queryByDisplayValue(link)).toBeNull();
    expect(auth.createInvitation).toHaveBeenCalledOnce();
  });

  it('preserves unknown invitation results and requires a fresh catalogue before another action', async () => {
    vi.mocked(auth.createInvitation).mockImplementationOnce(async (_project, _user, _signal, _mismatch, dispatched) => { dispatched?.(); throw new Error('secret-link-error'); }).mockResolvedValueOnce({ ...invitation, id: 'invitation-b', link: 'https://example.com/invitations#secret' });
    vi.mocked(auth.listInvitations).mockResolvedValue([invitation]);
    members(); await readyMembers(); click('邀请成员'); await dialogClick('创建邀请链接'); await screen.findByRole('alert');
    expect(screen.queryByText('secret-link-error')).toBeNull();
    expect(screen.getByRole('button', { name: '邀请成员' })).toBeDisabled();
    expect(auth.createInvitation).toHaveBeenCalledTimes(1);
    await clickWhenReady('读取当前邀请');
    await screen.findByText(/原操作结果仍未确认/);
    await clickWhenReady('邀请成员'); await dialogClick('创建邀请链接'); await screen.findByLabelText('一次性邀请链接');
    expect(auth.createInvitation).toHaveBeenCalledTimes(2);
  });

  it('retains a dispatched unknown invitation across navigation without replay', async () => {
    const result = deferred<import('../src/api/auth').CreatedProjectInvitation>();
    const guard = vi.fn();
    vi.mocked(auth.createInvitation).mockImplementation(async (_project, _user, _signal, _mismatch, dispatched) => { dispatched?.(); return result.promise; });
    const view = members({ active: true, onRoute: true, onGuardChange: guard }); await readyMembers();
    await clickWhenReady('邀请成员'); await dialogClick('创建邀请链接');
    await waitForState(() => expect(auth.createInvitation).toHaveBeenCalledOnce());
    view.rerender(<MembersPanel projectId="00000000-0000-4000-8000-000000000101" user={user} onRemoved={vi.fn()} active={false} onRoute={false} onGuardChange={guard} />);
    await act(async () => result.reject(new ApiError('network')));
    expect(guard).toHaveBeenCalledWith(true);
    view.rerender(<MembersPanel projectId="00000000-0000-4000-8000-000000000101" user={user} onRemoved={vi.fn()} active onRoute onGuardChange={guard} />);
    await screen.findByText(/邀请变更结果尚未确认/);
    expect(screen.getByRole('button', { name: '邀请成员' })).toBeDisabled();
    expect(auth.createInvitation).toHaveBeenCalledOnce();
  });

  it('settles a dispatched invitation with an unknown outcome during a pause without reading or replaying', async () => {
    const result = deferred<auth.CreatedProjectInvitation>();
    vi.mocked(auth.createInvitation).mockImplementation(async (_project, _user, _signal, _mismatch, dispatched) => { dispatched?.(); return result.promise; });
    members(); await readyMembers();
    await clickWhenReady('邀请成员'); await dialogClick('创建邀请链接');
    await waitForState(() => expect(auth.createInvitation).toHaveBeenCalledOnce());
    const reads = [vi.mocked(auth.getProjectAccess).mock.calls.length, vi.mocked(auth.listMembers).mock.calls.length, vi.mocked(auth.listInvitations).mock.calls.length];
    const resume = pauseAuthRequests();
    try {
      await act(async () => result.reject(new DOMException('cancelled', 'AbortError')));
      await screen.findByText(/邀请变更结果尚未确认/);
      expect(screen.getByText('Alice')).toBeVisible();
      expect(screen.getByRole('button', { name: '读取当前邀请' })).toBeEnabled();
      expect([vi.mocked(auth.getProjectAccess).mock.calls.length, vi.mocked(auth.listMembers).mock.calls.length, vi.mocked(auth.listInvitations).mock.calls.length]).toEqual(reads);
      expect(auth.createInvitation).toHaveBeenCalledOnce();
    } finally { resume(); }
  });

  it('keeps an unknown invitation unresolved when admin access is lost and requires an authorized catalogue read after restoration', async () => {
    const result = deferred<import('../src/api/auth').CreatedProjectInvitation>();
    vi.mocked(auth.createInvitation).mockImplementation(async (_project, _user, _signal, _mismatch, dispatched) => { dispatched?.(); return result.promise; });
    const props = { projectId: '00000000-0000-4000-8000-000000000101', user, onRemoved: vi.fn() };
    const view = render(<MembersPanel {...props} active onRoute />); await readyMembers();
    await clickWhenReady('邀请成员'); await dialogClick('创建邀请链接');
    await waitForState(() => expect(auth.createInvitation).toHaveBeenCalledOnce());
    view.rerender(<MembersPanel {...props} active={false} onRoute={false} />);
    actorRole = 'member';
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id, 'member'), member('Alice', 'admin')]));
    await act(async () => result.reject(new ApiError('network')));
    view.rerender(<MembersPanel {...props} active onRoute />);
    await screen.findByText('当前权限无法读取这些邀请，原操作结果仍未确认。');
    const readsBefore = vi.mocked(auth.listInvitations).mock.calls.length;
    await clickWhenReady('读取当前邀请');
    await readyMembers();
    expect(auth.listInvitations).toHaveBeenCalledTimes(readsBefore);
    expect(screen.queryByText(/已读取当前邀请/)).toBeNull();
    expect(screen.getByText('当前权限无法读取这些邀请，原操作结果仍未确认。')).toBeInTheDocument();
    expect(auth.createInvitation).toHaveBeenCalledOnce();

    view.rerender(<MembersPanel {...props} active={false} onRoute={false} />);
    actorRole = 'admin';
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id, 'admin'), member('Alice')]));
    view.rerender(<MembersPanel {...props} active onRoute />);
    await waitForState(() => expect(auth.listInvitations).toHaveBeenCalledTimes(readsBefore + 1));
    await readyMembers();
    expect(screen.getByRole('button', { name: '邀请成员' })).toBeDisabled();
    expect(screen.queryByText(/已读取当前邀请/)).toBeNull();
    await clickWhenReady('读取当前邀请');
    await screen.findByText(/已读取当前邀请；原操作结果仍未确认/);
    expect(auth.createInvitation).toHaveBeenCalledOnce();
  });

  it('does not mark an unknown invitation observed when its required catalogue read is superseded by demotion', async () => {
    vi.mocked(auth.createInvitation).mockImplementationOnce(async (_project, _user, _signal, _mismatch, dispatched) => { dispatched?.(); throw new ApiError('network'); });
    members(); await readyMembers();
    await clickWhenReady('邀请成员'); await dialogClick('创建邀请链接');
    await screen.findByText(/邀请变更结果尚未确认/);
    const held = deferred<auth.ProjectParticipants>();
    const reads = vi.mocked(auth.listMembers).mock.calls.length;
    vi.mocked(auth.listMembers).mockReturnValueOnce(held.promise);
    await clickWhenReady('读取当前邀请');
    await waitForState(() => expect(auth.listMembers).toHaveBeenCalledTimes(reads + 1));
    actorRole = 'member';
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id), member('Alice', 'admin')]));
    fireEvent(window, new Event('focus'));
    await screen.findByText('当前权限无法读取这些邀请，原操作结果仍未确认。');
    await act(async () => held.resolve(memberPage([member(user.id, 'admin'), member('Alice')])));
    expect(screen.queryByText(/已读取当前邀请/)).toBeNull();
    actorRole = 'admin';
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id, 'admin'), member('Alice')]));
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.getByRole('button', { name: '邀请成员' })).toBeDisabled());
    expect(screen.queryByText(/已读取当前邀请/)).toBeNull();
    await clickWhenReady('读取当前邀请');
    await screen.findByText(/已读取当前邀请；原操作结果仍未确认/);
  });

  it('keeps an unknown invitation visible when project access is lost', async () => {
    vi.mocked(auth.createInvitation).mockImplementationOnce(async (_project, _user, _signal, _mismatch, dispatched) => { dispatched?.(); throw new ApiError('network'); });
    members(); await readyMembers();
    await clickWhenReady('邀请成员'); await dialogClick('创建邀请链接');
    await screen.findByText(/邀请变更结果尚未确认/);
    vi.mocked(auth.getProjectAccess).mockRejectedValue(new ApiError('server', 404, 'not_found'));
    vi.mocked(auth.listMembers).mockRejectedValue(new ApiError('server', 404, 'not_found'));
    await clickWhenReady('读取当前邀请');
    await screen.findByText('当前权限无法读取这些邀请，原操作结果仍未确认。');
    expect(screen.queryByText(/已读取当前邀请/)).toBeNull();
    expect(auth.createInvitation).toHaveBeenCalledOnce();
  });

  it('keeps both unknown invitation revocations disabled after reading the catalogue', async () => {
    vi.mocked(auth.listInvitations).mockResolvedValue([invitation, { ...invitation, id: 'invitation-b' }]);
    vi.mocked(auth.revokeInvitation).mockImplementation(async (_project, _id, _user, _signal, _mismatch, dispatched) => { dispatched?.(); throw new ApiError('network'); });
    members(); await readyMembers();
    await clickWhenReady('撤销邀请 invitation-a'); await dialogClick('撤销邀请');
    await screen.findByText(/邀请变更结果尚未确认/);
    await clickWhenReady('读取当前邀请'); await screen.findByText(/原操作结果仍未确认/);
    expect(screen.getByRole('button', { name: '撤销邀请 invitation-a' })).toBeDisabled();
    await clickWhenReady('撤销邀请 invitation-b'); await dialogClick('撤销邀请');
    await screen.findByText(/邀请变更结果尚未确认/);
    await clickWhenReady('读取当前邀请'); await screen.findByText(/原操作结果仍未确认/);
    expect(screen.getByRole('button', { name: '撤销邀请 invitation-a' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '撤销邀请 invitation-b' })).toBeDisabled();
    expect(vi.mocked(auth.revokeInvitation).mock.calls.map((call) => call[1])).toEqual(['invitation-a', 'invitation-b']);
  });

  it('recovers ordinary member state when invitation access races a role loss', async () => {
    vi.mocked(auth.listMembers).mockResolvedValueOnce(memberPage([member(user.id, 'admin'), member('Alice')])).mockResolvedValue(memberPage([member(user.id), member('Alice', 'admin')]));
    vi.mocked(auth.listInvitations).mockImplementation(async () => { actorRole = 'member'; throw new ApiError('server', 403, 'forbidden'); });
    members(); await readyMembers(); expect(screen.getByText(/成员与邀请由项目管理员管理/)).toBeInTheDocument();
    expect(auth.listMembers).toHaveBeenCalledTimes(2); expect(auth.listInvitations).toHaveBeenCalledOnce();
    expect(screen.getByText('Alice').closest('.grant-row')!.querySelector('.badge')).toHaveTextContent('管理员');
  });

  it('handles membership removal between member-list and invitation-list requests', async () => {
    vi.mocked(auth.listMembers).mockResolvedValueOnce(memberPage([member(user.id, 'admin'), member('Alice')])).mockResolvedValue(memberPage([member('Alice', 'admin')]));
    vi.mocked(auth.listInvitations).mockImplementation(async () => { vi.mocked(auth.getProjectAccess).mockRejectedValue(new ApiError('server', 404, 'not_found')); throw new ApiError('server', 403); });
    const unavailable = vi.fn(); members({ onUnavailable: unavailable }); await readyMembers();
    expect(unavailable).toHaveBeenCalledOnce(); expect(screen.queryByRole('button', { name: '邀请成员' })).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('项目不存在');
  });

  it('keeps invitation loading failures visible and retries without inventing an empty invitation list', async () => {
    vi.mocked(auth.listInvitations).mockRejectedValueOnce(new ApiError('network')).mockResolvedValueOnce([]);
    members(); await readyMembers(); expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/还没有有效邀请/)).toBeNull();
    click('重试'); await screen.findByText(/还没有有效邀请/);
  });

  it('aborts an in-flight project mutation during navigation', async () => {
    const pending = deferred<auth.ProjectGrantResult>(); vi.mocked(auth.setProjectGrant).mockReturnValue(pending.promise);
    const change = vi.fn(); const view = members({ onMembershipChange: change }); await readyMembers();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } }); await dialogClick('保存角色');
    await waitForState(() => expect(auth.setProjectGrant).toHaveBeenCalledOnce());
    const signal = vi.mocked(auth.setProjectGrant).mock.calls[0]![3]; view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ grant: member('Alice', 'admin').directGrant!, actorAccess: directAccessFixture('00000000-0000-4000-8000-000000000101', user.id, 'admin') })); expect(change).not.toHaveBeenCalled();
  });

  it('keeps failed loading distinct from empty data, retries, and handles project access loss', async () => {
    vi.mocked(auth.listMembers).mockRejectedValueOnce(new Error('raw database secret')).mockRejectedValueOnce(new ApiError('server', 404, 'not_found'));
    const unavailable = vi.fn(); members({ onUnavailable: unavailable }); await readyMembers();
    expect(screen.getByRole('alert')).toHaveTextContent('操作未能完成'); expect(screen.queryByText('raw database secret')).toBeNull();
    click('重试'); await waitForState(() => expect(unavailable).toHaveBeenCalledOnce()); expect(screen.getByRole('alert')).toHaveTextContent('项目不存在或你没有访问权限');
  });

  it('uses access refusal independently of roster membership, discards old project data and aborts late responses', async () => {
    vi.mocked(auth.getProjectAccess).mockRejectedValueOnce(new ApiError('server', 404, 'not_found'));
    const unavailable = vi.fn(); vi.mocked(auth.listMembers).mockResolvedValueOnce(memberPage([member('Alice', 'admin')]));
    const view = members({ onUnavailable: unavailable }); await readyMembers(); expect(unavailable).toHaveBeenCalledOnce(); expect(screen.getByRole('alert')).toHaveTextContent('项目不存在');
    vi.mocked(auth.listMembers).mockReset();
    const earlierReads = vi.mocked(auth.listMembers).mock.calls.length;
    const earlierInvitations = vi.mocked(auth.listInvitations).mock.calls.length;
    const late = deferred<ProjectParticipants>(); vi.mocked(auth.listMembers).mockReturnValueOnce(late.promise);
    view.rerender(<MembersPanel projectId="00000000-0000-4000-8000-000000000102" user={user} onRemoved={vi.fn()} />);
    expect(screen.queryByText('Alice')).toBeNull();
    await waitForState(() => expect(auth.listMembers).toHaveBeenCalledTimes(earlierReads + 1));
    const signal = vi.mocked(auth.listMembers).mock.calls.at(-1)![1]; view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => late.resolve(memberPage([member(user.id, 'admin')]))); expect(auth.listInvitations).toHaveBeenCalledTimes(earlierInvitations);
  });

  it('keeps an unconfirmed removal closed and reads access loss without repeating the write', async () => {
    vi.mocked(auth.removeProjectGrant).mockImplementationOnce(async (_project, _user, _input, _signal, _mismatch, dispatched) => { dispatched?.(); throw new ApiError('server', 500, 'internal_error'); });
    const unavailable = vi.fn(); members({ onUnavailable: unavailable }); await readyMembers(); click('移除 Alice 的单独授权'); await dialogClick('移除授权');
    await screen.findByText(/服务端未确认这次成员变更/); expect(screen.queryByRole('dialog')).toBeNull();
    expect(auth.removeProjectGrant).toHaveBeenCalledOnce();
    vi.mocked(auth.listMembers).mockRejectedValue(new ApiError('server', 404, 'not_found')); click('读取当前成员');
    await waitForState(() => expect(unavailable).toHaveBeenCalledOnce()); expect(screen.queryByRole('dialog')).toBeNull();
    expect(auth.removeProjectGrant).toHaveBeenCalledOnce();
  });
});

describe('participant grants and unconfirmed writes', () => {
  it('shows effective and inherited roles separately and creates a grant for an inherited participant', async () => {
    const target = { ...member('Alice'), effectiveRole: 'admin' as const, inheritedFrom: { team: user.personalTeam, role: 'admin' as const } };
    const inherited = { ...member('Inherited', 'admin'), directGrant: null, inheritedFrom: { team: user.personalTeam, role: 'admin' as const } };
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id, 'admin'), target, inherited]));
    members(); await readyMembers();
    const targetRow = screen.getByText('Alice').closest('.grant-row')!;
    expect(targetRow.querySelector('.badge')).toHaveTextContent('管理员');
    expect(targetRow.children[2]).toHaveTextContent('管理员');
    expect(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' })).toHaveValue('member');
    expect(memberRoster().getByRole('combobox', { name: 'Inherited 的单独授权' })).toHaveValue('');
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Inherited 的单独授权' }), { target: { value: 'member' } });
    await dialogClick('保存角色');
    await waitForState(() => expect(auth.setProjectGrant).toHaveBeenCalledWith(expect.any(String), 'Inherited', { version: null, role: 'member', expectedUserId: user.id }, expect.any(AbortSignal), expect.any(Function), expect.any(Function)));
    await screen.findByText(/已将 Inherited 的单独授权保存为/);
    expect(screen.queryByRole('button', { name: '移除 Inherited' })).toBeNull();
    await waitFor(() => expect(memberRoster().getByRole('combobox', { name: 'Jianjun 的单独授权' })).not.toBeDisabled());
  });
  it('reports an unsaved role choice in the members section summary', async () => {
    const state = vi.fn(); members({ onStateChange: state }); await readyMembers();
    const select = memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' });
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.change(select, { target: { value: 'admin' } });
    await waitFor(() => expect(state).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: true })));
    await dialogClick('取消');
    await waitFor(() => expect(state).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: false })));
  });

  it('publishes a held grant without closing a dialog from an earlier presentation', async () => {
    const pending = deferred<auth.ProjectGrantResult>();
    vi.mocked(auth.setProjectGrant).mockImplementationOnce(async (_project, _user, _input, _signal, _mismatch, dispatched) => { dispatched?.(); return pending.promise; });
    const props = { projectId: '00000000-0000-4000-8000-000000000101', user, onRemoved: vi.fn() };
    const view = render(<MembersPanel {...props} active onRoute presentationGeneration={0} />); await readyMembers();
    const select = memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' });
    await waitFor(() => expect(select).toBeEnabled()); fireEvent.change(select, { target: { value: 'admin' } });
    const dialog = screen.getByRole('dialog');
    await dialogClick('保存角色');
    await waitForState(() => expect(auth.setProjectGrant).toHaveBeenCalledOnce());
    view.rerender(<MembersPanel {...props} active={false} onRoute presentationGeneration={1} />);
    await act(async () => pending.resolve({ grant: member('Alice', 'admin').directGrant!, actorAccess: directAccessFixture(props.projectId, user.id, 'admin') }));
    await screen.findByText(/已将 Alice 的单独授权保存为/);
    view.rerender(<MembersPanel {...props} active onRoute presentationGeneration={1} />);
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(auth.setProjectGrant).toHaveBeenCalledOnce();
  });

  it('holds a grant receipt until identity and fresh project access are confirmed', async () => {
    const pending = deferred<auth.ProjectGrantResult>();
    const permission = deferred<auth.ProjectAccess>();
    vi.mocked(auth.setProjectGrant).mockImplementationOnce(async (_project, _user, _input, _signal, _mismatch, dispatched) => { dispatched?.(); return pending.promise; });
    members(); await readyMembers();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    await dialogClick('保存角色');
    await waitForState(() => expect(auth.setProjectGrant).toHaveBeenCalledOnce());
    const resume = pauseAuthRequests();
    const priorReads = vi.mocked(auth.getProjectAccess).mock.calls.length;
    vi.mocked(auth.getProjectAccess).mockReturnValueOnce(permission.promise);
    await act(async () => pending.resolve({ grant: member('Alice', 'admin').directGrant!, actorAccess: directAccessFixture('00000000-0000-4000-8000-000000000101', user.id, 'admin') }));
    expect(screen.queryByText(/已将 Alice 的单独授权保存为/)).toBeNull();
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' })).toBeEnabled());
    expect(screen.getByText('Alice')).toBeVisible();
    expect(vi.mocked(auth.getProjectAccess).mock.calls.length).toBe(priorReads);
    resume();
    await waitForState(() => expect(vi.mocked(auth.getProjectAccess).mock.calls.length).toBeGreaterThan(priorReads));
    expect(screen.queryByText(/已将 Alice 的单独授权保存为/)).toBeNull();
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id), member('Alice', 'admin')]));
    await act(async () => permission.resolve(directAccessFixture('00000000-0000-4000-8000-000000000101', user.id, 'member')));
    await screen.findByText(/已将 Alice 的单独授权保存为/);
    expect(screen.queryByRole('button', { name: '邀请成员' })).toBeNull();
    expect(auth.setProjectGrant).toHaveBeenCalledOnce();
  });

  it('does not close a newer dialog when a paused grant receipt is eventually published', async () => {
    const pending = deferred<auth.ProjectGrantResult>();
    vi.mocked(auth.setProjectGrant).mockImplementationOnce(async (_project, _user, _input, _signal, _mismatch, dispatched) => { dispatched?.(); return pending.promise; });
    members(); await readyMembers();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    await dialogClick('保存角色');
    await waitForState(() => expect(auth.setProjectGrant).toHaveBeenCalledOnce());
    const resume = pauseAuthRequests();
    try {
      await act(async () => pending.resolve({ grant: member('Alice', 'admin').directGrant!, actorAccess: directAccessFixture('00000000-0000-4000-8000-000000000101', user.id, 'admin') }));
      await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' })).toBeEnabled());
      await dialogClick('取消');
      await clickWhenReady('邀请成员');
      const newer = screen.getByRole('dialog');
      expect(within(newer).getByRole('button', { name: '创建邀请链接' })).toBeVisible();
      resume();
      await screen.findByText(/已将 Alice 的单独授权保存为/);
      expect(screen.getByRole('dialog')).toBe(newer);
      expect(within(newer).getByRole('button', { name: '创建邀请链接' })).toBeVisible();
      expect(auth.setProjectGrant).toHaveBeenCalledOnce();
    } finally { resume(); }
  });

  it('records an aborted dispatched grant as unknown without waiting for identity admission', async () => {
    const pending = deferred<auth.ProjectGrantResult>();
    vi.mocked(auth.setProjectGrant).mockImplementationOnce(async (_project, _user, _input, _signal, _mismatch, dispatched) => { dispatched?.(); return pending.promise; });
    members(); await readyMembers();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    await dialogClick('保存角色');
    await waitForState(() => expect(auth.setProjectGrant).toHaveBeenCalledOnce());
    const reads = [vi.mocked(auth.getProjectAccess).mock.calls.length, vi.mocked(auth.listMembers).mock.calls.length];
    const resume = pauseAuthRequests();
    try {
      await act(async () => pending.reject(new DOMException('cancelled', 'AbortError')));
      await screen.findByText(/服务端未确认这次成员变更/);
      expect(screen.getByText('Alice')).toBeVisible();
      expect(screen.getByRole('button', { name: '读取当前成员' })).toBeEnabled();
      expect([vi.mocked(auth.getProjectAccess).mock.calls.length, vi.mocked(auth.listMembers).mock.calls.length]).toEqual(reads);
      expect(auth.setProjectGrant).toHaveBeenCalledOnce();
    } finally { resume(); }
  });

  it.each(['network', 'denied'] as const)('holds confirmed grant details across permission %s until recovery', async (failure) => {
    vi.mocked(auth.setProjectGrant).mockImplementationOnce(async (projectId, userId, input) => {
      vi.mocked(auth.getProjectAccess).mockRejectedValueOnce(failure === 'network' ? new ApiError('network') : new ApiError('server', 404, 'not_found'));
      return { grant: member(userId, input.role).directGrant!, actorAccess: directAccessFixture(projectId, user.id, 'admin') };
    });
    members(); await readyMembers();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    await dialogClick('保存角色');
    await screen.findByRole('alert');
    expect(screen.queryByText(/已将 Alice 的单独授权保存为/)).toBeNull();
    expect(auth.setProjectGrant).toHaveBeenCalledOnce();
    vi.mocked(auth.getProjectAccess).mockResolvedValue(directAccessFixture('00000000-0000-4000-8000-000000000101', user.id, 'admin'));
    fireEvent(window, new Event('focus'));
    await screen.findByText(/已将 Alice 的单独授权保存为/);
    expect(auth.setProjectGrant).toHaveBeenCalledOnce();
  });

  it('does not publish a grant receipt after identity invalidation', async () => {
    const pending = deferred<auth.ProjectGrantResult>();
    vi.mocked(auth.setProjectGrant).mockImplementationOnce(async (_project, _user, _input, _signal, _mismatch, dispatched) => { dispatched?.(); return pending.promise; });
    members(); await readyMembers();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    await dialogClick('保存角色');
    const resume = pauseAuthRequests();
    await act(async () => pending.resolve({ grant: member('Alice', 'admin').directGrant!, actorAccess: directAccessFixture('00000000-0000-4000-8000-000000000101', user.id, 'admin') }));
    expect(screen.queryByText(/已将 Alice 的单独授权保存为/)).toBeNull();
    act(() => invalidateAuthRequests()); resume();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/已将 Alice 的单独授权保存为/)).toBeNull();
  });

  it('retains the confirmed receipt when the subsequent roster read fails', async () => {
    vi.mocked(auth.setProjectGrant).mockImplementation(async (projectId, userId, input) => {
      vi.mocked(auth.listMembers).mockRejectedValue(new ApiError('network'));
      return { grant: member(userId, input.role).directGrant!, actorAccess: directAccessFixture(projectId, user.id, 'admin') };
    });
    members(); await readyMembers();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    await dialogClick('保存角色');
    await screen.findByText('已将 Alice 的单独授权保存为管理员。');
    await screen.findByRole('alert');
    expect(screen.queryByText(/服务端未确认这次成员变更/)).toBeNull();
    expect(auth.setProjectGrant).toHaveBeenCalledOnce();
  });
  it('handles identity mismatch through the scope owner without treating it as a grant conflict', async () => {
    const mismatch = vi.fn();
    vi.mocked(auth.setProjectGrant).mockImplementation(async (_projectId, _userId, _input, _signal, onMismatch) => {
      onMismatch(); throw new ApiError('server', 409, 'identity_mismatch');
    });
    render(<MembersPanel projectId="00000000-0000-4000-8000-000000000101" user={user} onRemoved={vi.fn()} />, { taskCache: { viewerId: user.id, onIdentityMismatch: mismatch } });
    await readyMembers();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    await dialogClick('保存角色');
    await screen.findByText(/登录账号已变化/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/成员状态已变化/)).toBeNull();
    expect(screen.queryByText('Alice@example.com')).toBeNull();
    expect(mismatch).toHaveBeenCalledOnce(); expect(auth.setProjectGrant).toHaveBeenCalledOnce();
  });
  it.each(['network', 'protocol', 'server', 'unknown'] as const)('closes an unconfirmed %s write and requires a new read and review', async (kind) => {
    vi.mocked(auth.setProjectGrant).mockImplementation(async (_project, _user, _input, _signal, _mismatch, dispatched) => {
      dispatched?.();
      vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id, 'admin'), { ...member('Alice', 'admin'), directGrant: { ...member('Alice', 'admin').directGrant!, version: 9223372036854775807n } }]));
      throw kind === 'unknown' ? new ApiError('server', 409, 'write_outcome_unknown') : new ApiError(kind, kind === 'server' ? 500 : null);
    });
    members(); await readyMembers();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'admin' } });
    await dialogClick('保存角色');
    await screen.findByText(/服务端未确认这次成员变更/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' })).toBeDisabled();
    click('读取当前成员');
    await screen.findByText(/原写入结果仍未确认/);
    expect(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' })).toHaveValue('admin');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(auth.setProjectGrant).toHaveBeenCalledOnce();
    fireEvent.change(memberRoster().getByRole('combobox', { name: 'Alice 的单独授权' }), { target: { value: 'member' } });
    expect(screen.getByRole('dialog')).toHaveTextContent('单独授权：管理员 → 成员');
    await dialogClick('取消');
    expect(auth.setProjectGrant).toHaveBeenCalledOnce();
  });
});

describe('management feedback', () => {
  it('isolates avatar loading and failure by member identity and source', () => {
    const profile = { userId: 'member-a', name: 'Alice', email: 'alice@example.com', avatarUrl: 'https://example.test/a.png' };
    const view = render(<Identity user={profile} self />);
    const avatar = () => view.container.querySelector('.management-avatar')!;
    const imageA = avatar().querySelector('img')!;
    expect(avatar()).toHaveAttribute('aria-hidden', 'true'); expect(imageA).toHaveAttribute('alt', '');
    expect(avatar()).toHaveTextContent('AL'); expect(imageA).not.toBeVisible();
    fireEvent.error(imageA); expect(avatar().querySelector('img')).toBeNull(); expect(avatar()).toHaveTextContent('AL');
    view.rerender(<Identity user={{ ...profile }} self />); expect(avatar().querySelector('img')).toBeNull();
    view.rerender(<Identity user={{ ...profile, avatarUrl: 'https://example.test/b.png' }} self />);
    const imageB = avatar().querySelector('img')!; expect(imageB).toHaveAttribute('src', 'https://example.test/b.png');
    fireEvent.load(imageB); fireEvent.error(imageA); expect(imageB).toBeVisible();
    view.rerender(<Identity user={{ ...profile, avatarUrl: 'https://example.test/b.png' }} self />);
    expect(avatar().querySelector('img')).toBe(imageB); expect(imageB).toBeVisible();
    view.rerender(<Identity user={{ ...profile, userId: 'member-b', avatarUrl: 'https://example.test/b.png' }} self />);
    expect(avatar().querySelector('img')).not.toBe(imageB); expect(avatar()).toHaveTextContent('AL');
    fireEvent.error(avatar().querySelector('img')!);
    view.rerender(<Identity user={{ ...profile, userId: 'member-c', avatarUrl: 'https://example.test/b.png' }} self />);
    expect(avatar().querySelector('img')).not.toBeNull(); expect(screen.getByText(/Alice/)).toHaveTextContent('Alice');
  });

  it('ignores events from an image replaced while still loading', () => {
    const profile = { userId: 'member-a', name: 'Alice', email: null, avatarUrl: 'https://example.test/a.png' };
    const view = render(<Identity user={profile} />);
    const old = view.container.querySelector('img')!;
    view.rerender(<Identity user={{ ...profile, avatarUrl: 'https://example.test/b.png' }} />);
    const current = view.container.querySelector('img')!;
    fireEvent.load(old); fireEvent.error(old);
    expect(current).not.toBeVisible(); expect(view.container.querySelector('.management-avatar')).toHaveTextContent('AL');
    fireEvent.load(current); expect(current).toBeVisible();
    fireEvent.error(old); expect(current).toBeVisible();
  });

  it.each([null, ''])('uses local ID initials without an image for source %s', (avatarUrl) => {
    const view = render(<Identity user={{ id: 'id-only', name: null, email: null, avatarUrl }} />);
    expect(view.container.querySelector('.management-avatar')).toHaveTextContent('ID');
    expect(view.container.querySelector('img')).toBeNull(); expect(screen.getByText('id-only')).toBeVisible();
  });

  it('renders only safe error fields and normalized fallback identities', () => {
    const view = render(<><ManagementError error={new ApiError('server', 401)} /><Identity user={{ name: null, email: null, id: 'id-only', avatarUrl: null }} /><Identity user={{ name: null, email: 'email-only', userId: 'user-id', avatarUrl: null }} /><Identity user={{ name: null, email: null, userId: 'user-id', avatarUrl: null }} /></>);
    expect(screen.getByText('登录状态已失效，请重新登录。')).toBeInTheDocument(); expect(screen.getByText('id-only')).toBeInTheDocument(); expect(screen.getByText('user-id')).toBeInTheDocument();
    view.rerender(<ManagementError error={new ApiError('server', 404)} />); expect(screen.getByRole('alert')).toHaveTextContent('项目不存在');
  });

  it.each(['resolve', 'reject'])('ignores a late clipboard %s after the once-only dialog closes', async (result) => {
    const copy = deferred<void>(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockReturnValue(copy.promise) } });
    const view = render(<SecretDialog kind="token" secret="once-only" onClose={vi.fn()} />);
    await dialogClick('复制'); view.unmount();
    await act(async () => { if (result === 'resolve') copy.resolve(); else copy.reject(new Error('private clipboard error')); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('traps focus in both directions and restores root inert state when a dialog closes', async () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
    const view = render(<AccountPage user={user} onSignOut={vi.fn()} onIdentityMismatch={vi.fn()} />, { container: root }); await tokensTab(); click('创建令牌');
    expect(root).toHaveAttribute('inert'); const dialog = screen.getByRole('dialog'); const buttons = within(dialog).getAllByRole('button');
    buttons.at(-1)!.focus(); fireEvent.keyDown(document, { key: 'Tab' }); expect(within(dialog).getByRole('button', { name: '关闭对话框' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true }); expect(buttons.at(-1)).toHaveFocus();
    await dialogClick('取消'); expect(root).not.toHaveAttribute('inert'); view.unmount(); root.remove();
  });
});
