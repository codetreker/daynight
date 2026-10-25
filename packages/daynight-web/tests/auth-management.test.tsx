import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocaleRender } from './helpers/renderWithLocale';
import * as auth from '../src/api/auth';
import { messagesByLocale } from '../src/i18n/messages';
import { ApiError } from '../src/api/client';
import { AccountPage } from '../src/features/management/AccountPage';
import { MembersPanel } from '../src/features/management/MembersPanel';
import { Identity, ManagementError, SecretDialog } from '../src/features/management/feedback';
import type { CurrentUser, PersonalAccessToken, ProjectInvitation, ProjectMember } from '../src/api/auth';

vi.mock('../src/api/auth', () => ({
  listTokens: vi.fn(), createToken: vi.fn(), revokeToken: vi.fn(), updateTokenExpiry: vi.fn(),
  listMembers: vi.fn(), listInvitations: vi.fn(), createInvitation: vi.fn(), revokeInvitation: vi.fn(), setMemberRole: vi.fn(), removeMember: vi.fn(),
}));

const render = createLocaleRender('zh-CN');

const user: CurrentUser = { id: 'user-a', name: 'Jianjun', email: 'a@example.com', emailVerified: true, avatarUrl: null };
const token: PersonalAccessToken = { id: 'token-a', name: 'MacBook', createdAt: '2026-10-22T12:00:00Z', expiresAt: '2099-10-22T12:00:00Z' };
const member = (id: string, role: 'admin' | 'member' = 'member'): ProjectMember => ({
  projectId: 'project-a', userId: id, name: id === user.id ? user.name : id, email: `${id}@example.com`, avatarUrl: null, role,
  version: 9223372036854775806n, createdAt: '2026-10-22T12:00:00Z', updatedAt: '2026-10-22T12:00:00Z',
});
const invitation: ProjectInvitation = { id: 'invitation-a', projectId: 'project-a', createdBy: user.id, createdAt: '2026-10-22T12:00:00Z', expiresAt: '2099-10-29T12:00:00Z', consumedAt: null, consumedBy: null, revokedAt: null };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const dialogClick = (name: string) => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name }));
const account = () => render(<AccountPage user={user} onSignOut={vi.fn()} onIdentityMismatch={vi.fn()} />);
const members = (props: Partial<Parameters<typeof MembersPanel>[0]> = {}) => render(<MembersPanel projectId="project-a" projectName="Very long project name" user={user} onRemoved={vi.fn()} {...props} />);
const tokensTab = async () => { click('访问令牌'); await waitFor(() => expect(screen.queryByText('正在加载访问令牌…')).toBeNull()); };
const readyMembers = async () => { await waitFor(() => expect(screen.queryByText('正在加载项目成员…')).toBeNull()); };
const createForm = async (name = 'new device', expiry: string | null = null) => {
  click('创建令牌');
  fireEvent.change(screen.getByLabelText(/令牌名称/), { target: { value: name } });
  if (expiry !== null) {
    fireEvent.change(screen.getByLabelText('有效期'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('到期日期和时间'), { target: { value: expiry } });
  }
  fireEvent.submit(document.getElementById('create-token-form')!);
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auth.listTokens).mockResolvedValue([]);
  vi.mocked(auth.listMembers).mockResolvedValue([member(user.id, 'admin'), member('Alice')]);
  vi.mocked(auth.listInvitations).mockResolvedValue([]);
  vi.mocked(auth.revokeToken).mockResolvedValue();
  vi.mocked(auth.setMemberRole).mockResolvedValue(member('Alice', 'admin'));
  vi.mocked(auth.removeMember).mockResolvedValue();
  vi.mocked(auth.revokeInvitation).mockResolvedValue();
});

describe('account credentials', () => {
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
    account(); click('访问令牌');
    expect(screen.getByText('正在加载访问令牌…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建令牌' })).toBeDisabled();
    await act(async () => result.resolve([{ ...token, expiresAt: '2000-01-01T00:00:00Z' }]));
    expect(screen.getByText('已过期')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /撤销令牌/ })).toBeNull();
    const opener = screen.getByRole('button', { name: '创建令牌' }); opener.focus(); fireEvent.click(opener);
    expect(screen.getByLabelText(/令牌名称/)).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(opener).toHaveFocus();
  });

  it('validates code points and optional expiration, shows the PAT once, copies it, and warns on implicit close', async () => {
    vi.mocked(auth.createToken).mockResolvedValue({ ...token, token: 'pat-secret-once' });
    const copy = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    account(); await tokensTab();
    await createForm('😀'.repeat(101));
    expect(screen.getByRole('alert')).toHaveTextContent('1–100'); expect(auth.createToken).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/令牌名称/), { target: { value: '😀'.repeat(100) } });
    fireEvent.change(screen.getByLabelText('有效期'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('到期日期和时间'), { target: { value: '2000-01-01T00:00' } });
    fireEvent.submit(document.getElementById('create-token-form')!); expect(auth.createToken).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('到期日期和时间'), { target: { value: '2099-10-22T12:00' } });
    fireEvent.submit(document.getElementById('create-token-form')!);
    await screen.findByRole('dialog', { name: '访问令牌已创建' });
    expect(auth.createToken).toHaveBeenCalledWith({ name: '😀'.repeat(100), expiresAt: new Date('2099-10-22T12:00').toISOString() }, expect.any(AbortSignal));
    expect(screen.getByLabelText('一次性访问令牌')).toHaveValue('pat-secret-once');
    dialogClick('复制'); await screen.findByText('已复制。'); expect(copy).toHaveBeenCalledWith('pat-secret-once');
    fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.getByRole('alert')).toHaveTextContent('关闭后无法恢复');
    dialogClick('返回保存'); expect(screen.queryByRole('alert')).toBeNull();
    dialogClick('关闭对话框'); dialogClick('确认已保存，关闭');
    expect(screen.queryByDisplayValue('pat-secret-once')).toBeNull(); expect(screen.getByText('MacBook')).toBeInTheDocument();
    click('个人资料'); await tokensTab(); expect(screen.queryByDisplayValue('pat-secret-once')).toBeNull();
  });

  it('retains selectable secret on clipboard rejection, then explicitly closes it', async () => {
    vi.mocked(auth.createToken).mockResolvedValue({ ...token, token: 'private-clipboard-secret' });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('clipboard secret details')) } });
    account(); await tokensTab(); await createForm();
    await screen.findByLabelText('一次性访问令牌'); dialogClick('复制');
    await screen.findByText(/浏览器未允许自动复制/);
    const secret = screen.getByLabelText('一次性访问令牌') as HTMLTextAreaElement;
    expect(secret).toHaveFocus(); expect(secret.selectionStart).toBe(0); expect(secret.selectionEnd).toBe(secret.value.length);
    expect(screen.queryByText('clipboard secret details')).toBeNull();
    dialogClick('我已保存，关闭'); expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps failed creation and revocation recoverable, disables duplicate submissions and reloads revoked metadata', async () => {
    vi.mocked(auth.listTokens).mockResolvedValueOnce([token]).mockResolvedValue([]);
    vi.mocked(auth.createToken).mockRejectedValue(new Error('sensitive PAT raw error'));
    account(); await tokensTab(); await createForm('device');
    await screen.findByRole('alert'); expect(screen.queryByText(/sensitive PAT/)).toBeNull();
    dialogClick('取消'); click('撤销令牌 MacBook');
    const pending = deferred<void>(); vi.mocked(auth.revokeToken).mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new ApiError('server', 401));
    dialogClick('撤销令牌'); expect(screen.getByRole('button', { name: '正在撤销…' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' }); fireEvent.keyDown(document, { key: 'Tab' }); expect(within(screen.getByRole('dialog')).getByRole('combobox', { name: '语言 / Language' })).toHaveFocus();
    await act(async () => pending.reject(new Error('internal raw secret')));
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('操作未能完成');
    dialogClick('撤销令牌'); await screen.findByText('登录状态已失效，请重新登录。');
    vi.mocked(auth.revokeToken).mockResolvedValue(); dialogClick('撤销令牌');
    await screen.findByText(/还没有访问令牌/); expect(screen.queryByRole('dialog')).toBeNull();
    expect(auth.revokeToken).toHaveBeenCalledWith(token.id, expect.any(AbortSignal));
  });

  it('rejects blank, NUL and malformed Unicode names while preserving an accepted name verbatim', async () => {
    vi.mocked(auth.createToken).mockResolvedValue({ ...token, token: 'new-secret' });
    account(); await tokensTab(); await createForm('   ');
    expect(auth.createToken).not.toHaveBeenCalled();
    for (const value of ['bad\0name', '\ud800']) {
      fireEvent.change(screen.getByLabelText(/令牌名称/), { target: { value } });
      fireEvent.submit(document.getElementById('create-token-form')!);
      expect(auth.createToken).not.toHaveBeenCalled();
    }
    fireEvent.change(screen.getByLabelText(/令牌名称/), { target: { value: '  device name  ' } });
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
    account(); await tokensTab(); await createForm('  unchanged name 😀  ', '2000-01-01T00:00');
    const en = messagesByLocale.en.auth.management;
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('combobox', { name: '语言 / Language' }), { target: { value: 'en' } });
    expect(screen.getByRole('dialog', { name: en.account.createTitle })).toBeInTheDocument();
    expect(document.getElementById('token-name')).toHaveValue('  unchanged name 😀  ');
    expect(screen.getByLabelText(en.account.expiryDateLabel)).toHaveValue('2000-01-01T00:00'); expect(screen.getByRole('alert')).toHaveTextContent(en.account.validation);
    expect(auth.listTokens).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText(en.account.expiryDateLabel), { target: { value: '2099-10-22T12:31' } });
    fireEvent.submit(document.getElementById('create-token-form')!);
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('combobox', { name: '语言 / Language' }), { target: { value: 'zh-CN' } });
    expect(screen.getByRole('button', { name: '正在创建…' })).toBeDisabled();
    expect(auth.createToken).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ ...token, token: 'unaltered-secret-value' }));
    dialogClick('复制'); await screen.findByText(/浏览器未允许自动复制/);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('combobox', { name: '语言 / Language' }), { target: { value: 'en' } });
    expect(screen.getByRole('dialog', { name: en.secret.tokenTitle })).toBeInTheDocument();
    expect(screen.getByLabelText(en.secret.tokenLabel)).toHaveValue('unaltered-secret-value');
    expect(screen.getByRole('alert')).toHaveTextContent(en.secret.tokenCloseWarning);
    expect(screen.getByRole('status')).toHaveTextContent(en.secret.copyFailed);
    expect(auth.createToken).toHaveBeenCalledWith({ name: '  unchanged name 😀  ', expiresAt: new Date('2099-10-22T12:31').toISOString() }, expect.any(AbortSignal));
    expect(auth.createToken).toHaveBeenCalledOnce();
    dialogClick(en.secret.confirmClose); expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('aborts stale loads and never renders old account metadata after account replacement', async () => {
    const late = deferred<readonly PersonalAccessToken[]>(); vi.mocked(auth.listTokens).mockReturnValue(late.promise);
    const view = account(); click('访问令牌');
    const signal = vi.mocked(auth.listTokens).mock.calls[0]![0];
    view.rerender(<AccountPage user={{ ...user, id: 'new-account', name: 'New account' }} onSignOut={vi.fn()} onIdentityMismatch={vi.fn()} />);
    expect(signal.aborted).toBe(true); expect(screen.getByText('New account')).toBeInTheDocument();
    await act(async () => late.resolve([token])); expect(screen.queryByText('MacBook')).toBeNull();
  });
});

describe('authoritative project management', () => {
  it('reads regular member state without requesting administrator invitations', async () => {
    vi.mocked(auth.listMembers).mockResolvedValue([member(user.id), member('Alice', 'admin')]);
    members(); await readyMembers();
    expect(screen.getByText(/成员与邀请由项目管理员管理/)).toBeInTheDocument();
    expect(auth.listInvitations).not.toHaveBeenCalled(); expect(screen.queryByRole('combobox')).toBeNull(); expect(screen.queryByRole('button', { name: '邀请成员' })).toBeNull();
    expect(screen.getByText('Very long project name · 管理协作成员与加入邀请')).toBeInTheDocument();
  });

  it('protects the last admin and submits exact observed int64 version on confirmed promotion', async () => {
    const change = vi.fn(); members({ onMembershipChange: change }); await readyMembers();
    expect(screen.getByRole('combobox', { name: 'Jianjun 的项目角色' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '移除 Jianjun' })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Alice 的项目角色' }), { target: { value: 'admin' } });
    expect(auth.setMemberRole).not.toHaveBeenCalled();
    dialogClick('取消'); expect(screen.getByRole('combobox', { name: 'Alice 的项目角色' })).toHaveValue('member');
    fireEvent.change(screen.getByRole('combobox', { name: 'Alice 的项目角色' }), { target: { value: 'admin' } });
    dialogClick('保存角色'); await waitFor(() => expect(change).toHaveBeenCalledOnce()); await readyMembers();
    expect(auth.setMemberRole).toHaveBeenCalledWith('project-a', 'Alice', { version: 9223372036854775806n, role: 'admin' }, expect.any(AbortSignal));
  });

  it.each([403, 409])('reloads authoritative role after %s, hides privileged actions and does not repeat the mutation', async (status) => {
    vi.mocked(auth.listMembers).mockResolvedValueOnce([member(user.id, 'admin'), member('Alice')]).mockResolvedValue([member(user.id), member('Alice', 'admin')]);
    vi.mocked(auth.setMemberRole).mockRejectedValue(new ApiError('server', status, status === 409 ? 'conflict' : 'forbidden'));
    members(); await readyMembers();
    fireEvent.change(screen.getByRole('combobox', { name: 'Alice 的项目角色' }), { target: { value: 'admin' } }); dialogClick('保存角色');
    await screen.findByText(/成员与邀请由项目管理员管理/);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('combobox')).toBeNull();
    expect(auth.listInvitations).toHaveBeenCalledOnce(); expect(auth.setMemberRole).toHaveBeenCalledOnce(); expect(auth.listMembers).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent(status === 409 ? '成员状态已变化' : '项目权限已变化');
  });

  it('localizes a conflict notice and the current role without reloading network state on language change', async () => {
    vi.mocked(auth.listMembers).mockResolvedValueOnce([member(user.id, 'admin'), member('Alice')]).mockResolvedValue([member(user.id), member('Alice', 'admin')]);
    vi.mocked(auth.setMemberRole).mockRejectedValue(new ApiError('server', 409, 'conflict'));
    members(); await readyMembers();
    fireEvent.change(screen.getByRole('combobox', { name: 'Alice 的项目角色' }), { target: { value: 'admin' } });
    const en = messagesByLocale.en.auth.management;
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('combobox', { name: '语言 / Language' }), { target: { value: 'en' } });
    expect(screen.getByRole('dialog', { name: en.members.roleTitle({ name: 'Alice' }) })).toBeInTheDocument();
    dialogClick(en.members.saveRole);
    await screen.findByText(en.members.memberNotice);
    expect(screen.getByRole('status')).toHaveTextContent(en.members.notice.conflictReloaded);
    expect(auth.listMembers).toHaveBeenCalledTimes(2); expect(auth.listInvitations).toHaveBeenCalledOnce(); expect(auth.setMemberRole).toHaveBeenCalledOnce();
  });

  it('reloads after self-demotion and gives up its admin actions immediately', async () => {
    vi.mocked(auth.listMembers).mockResolvedValueOnce([member(user.id, 'admin'), member('Alice', 'admin')]).mockResolvedValue([member(user.id), member('Alice', 'admin')]);
    members(); await readyMembers();
    fireEvent.change(screen.getByRole('combobox', { name: 'Jianjun 的项目角色' }), { target: { value: 'member' } });
    expect(screen.getByText(/变更后，你将失去成员管理权限/)).toBeInTheDocument(); dialogClick('保存角色');
    await screen.findByText(/成员与邀请由项目管理员管理/); expect(screen.queryByRole('button', { name: '邀请成员' })).toBeNull();
  });

  it('confirms and removes another member with its observed version, then navigates after explicit self-removal', async () => {
    vi.mocked(auth.listMembers).mockResolvedValue([member(user.id, 'admin'), member('Alice', 'admin')]);
    const removed = vi.fn(); members({ onRemoved: removed }); await readyMembers();
    click('移除 Alice'); expect(screen.getByText(/对方的浏览器和访问令牌/)).toBeInTheDocument(); dialogClick('移除成员');
    await waitFor(() => expect(auth.removeMember).toHaveBeenCalledOnce()); await readyMembers();
    expect(auth.removeMember).toHaveBeenCalledWith('project-a', 'Alice', 9223372036854775806n, expect.any(AbortSignal)); expect(removed).not.toHaveBeenCalled();
    click('移除 Jianjun'); expect(screen.getByText(/你将无法继续访问这个项目/)).toBeInTheDocument(); dialogClick('移除成员');
    await waitFor(() => expect(removed).toHaveBeenCalledOnce());
  });

  it('creates a seven-day once-only invitation and revokes it without retaining its link', async () => {
    vi.mocked(auth.createInvitation).mockResolvedValue({ ...invitation, link: 'https://daynight.test/invitations#once-secret' });
    members(); await readyMembers(); expect(screen.getByText(/还没有有效邀请/)).toBeInTheDocument();
    click('邀请成员'); expect(screen.getByText('7 天后到期 · 单次使用 · 加入角色：成员')).toBeInTheDocument(); dialogClick('创建邀请链接');
    await screen.findByLabelText('一次性邀请链接'); expect(auth.createInvitation).toHaveBeenCalledWith('project-a', expect.any(AbortSignal));
    expect(screen.getByLabelText('一次性邀请链接')).toHaveValue('https://daynight.test/invitations#once-secret'); dialogClick('我已保存，关闭');
    expect(screen.queryByDisplayValue(/once-secret/)).toBeNull(); click('撤销邀请 invitation-a');
    expect(screen.getByText(/这个邀请链接将立即失效/)).toBeInTheDocument(); dialogClick('撤销邀请');
    await screen.findByText(/还没有有效邀请/); expect(auth.revokeInvitation).toHaveBeenCalledWith('project-a', 'invitation-a', expect.any(AbortSignal));
  });

  it('retains invitation failures in the dialog and can retry or cancel safely', async () => {
    vi.mocked(auth.createInvitation).mockRejectedValueOnce(new Error('secret-link-error')).mockResolvedValueOnce({ ...invitation, id: 'invitation-b', link: 'https://example.com/invitations#secret' });
    vi.mocked(auth.revokeInvitation).mockRejectedValueOnce(new Error('internal secret'));
    vi.mocked(auth.listInvitations).mockResolvedValue([invitation]);
    members(); await readyMembers(); click('邀请成员'); dialogClick('创建邀请链接'); await screen.findByRole('alert');
    expect(screen.queryByText('secret-link-error')).toBeNull(); dialogClick('创建邀请链接'); await screen.findByLabelText('一次性邀请链接');
    fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.getByRole('alert')).toHaveTextContent('邀请链接'); dialogClick('确认已保存，关闭');
    click('撤销邀请 invitation-a'); dialogClick('撤销邀请'); await screen.findByRole('alert'); dialogClick('取消'); expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('recovers ordinary member state when invitation access races a role loss', async () => {
    vi.mocked(auth.listMembers).mockResolvedValueOnce([member(user.id, 'admin'), member('Alice')]).mockResolvedValue([member(user.id), member('Alice', 'admin')]);
    vi.mocked(auth.listInvitations).mockRejectedValue(new ApiError('server', 403, 'forbidden'));
    members(); await readyMembers(); expect(screen.getByText(/成员与邀请由项目管理员管理/)).toBeInTheDocument();
    expect(auth.listMembers).toHaveBeenCalledTimes(2); expect(auth.listInvitations).toHaveBeenCalledOnce();
  });

  it('handles membership removal between member-list and invitation-list requests', async () => {
    vi.mocked(auth.listMembers).mockResolvedValueOnce([member(user.id, 'admin'), member('Alice')]).mockResolvedValue([member('Alice', 'admin')]);
    vi.mocked(auth.listInvitations).mockRejectedValue(new ApiError('server', 403));
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
    const pending = deferred<ProjectMember>(); vi.mocked(auth.setMemberRole).mockReturnValue(pending.promise);
    const change = vi.fn(); const view = members({ onMembershipChange: change }); await readyMembers();
    fireEvent.change(screen.getByRole('combobox', { name: 'Alice 的项目角色' }), { target: { value: 'admin' } }); dialogClick('保存角色');
    const signal = vi.mocked(auth.setMemberRole).mock.calls[0]![3]; view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(member('Alice', 'admin'))); expect(change).not.toHaveBeenCalled();
  });

  it('keeps failed loading distinct from empty data, retries, and handles project access loss', async () => {
    vi.mocked(auth.listMembers).mockRejectedValueOnce(new Error('raw database secret')).mockRejectedValueOnce(new ApiError('server', 404, 'not_found'));
    const unavailable = vi.fn(); members({ onUnavailable: unavailable }); await readyMembers();
    expect(screen.getByRole('alert')).toHaveTextContent('操作未能完成'); expect(screen.queryByText('raw database secret')).toBeNull();
    click('重试'); await waitFor(() => expect(unavailable).toHaveBeenCalledOnce()); expect(screen.getByRole('alert')).toHaveTextContent('项目不存在或你没有访问权限');
  });

  it('rejects a list without current membership, discards old project data on navigation, and aborts late responses', async () => {
    const unavailable = vi.fn(); vi.mocked(auth.listMembers).mockResolvedValueOnce([member('Alice', 'admin')]);
    const view = members({ onUnavailable: unavailable }); await readyMembers(); expect(unavailable).toHaveBeenCalledOnce(); expect(screen.getByRole('alert')).toHaveTextContent('项目不存在');
    const late = deferred<readonly ProjectMember[]>(); vi.mocked(auth.listMembers).mockReturnValueOnce(late.promise);
    view.rerender(<MembersPanel projectId="project-b" projectName="Different" user={user} onRemoved={vi.fn()} />);
    expect(screen.queryByText('Alice')).toBeNull();
    const signal = vi.mocked(auth.listMembers).mock.calls[1]![1]; view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => late.resolve([member(user.id, 'admin')])); expect(auth.listInvitations).not.toHaveBeenCalled();
  });

  it('shows ordinary errors without privileged dialog data and recovers project loss during removal', async () => {
    vi.mocked(auth.removeMember).mockRejectedValueOnce(new ApiError('server', 500, 'internal_error')).mockRejectedValueOnce(new ApiError('server', 404, 'not_found'));
    const unavailable = vi.fn(); members({ onUnavailable: unavailable }); await readyMembers(); click('移除 Alice'); dialogClick('移除成员');
    await screen.findByRole('alert'); expect(screen.getByRole('dialog')).toBeInTheDocument();
    vi.mocked(auth.listMembers).mockRejectedValue(new ApiError('server', 404, 'not_found')); dialogClick('移除成员');
    await waitFor(() => expect(unavailable).toHaveBeenCalledOnce()); expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('management feedback', () => {
  it('renders only safe error fields and normalized fallback identities', () => {
    const view = render(<><ManagementError error={new ApiError('server', 401)} /><Identity user={{ name: null, email: null, id: 'id-only' }} /><Identity user={{ name: null, email: 'email-only', userId: 'user-id' }} /><Identity user={{ name: null, email: null, userId: 'user-id' }} /></>);
    expect(screen.getByText('登录状态已失效，请重新登录。')).toBeInTheDocument(); expect(screen.getByText('id-only')).toBeInTheDocument(); expect(screen.getByText('user-id')).toBeInTheDocument();
    view.rerender(<ManagementError error={new ApiError('server', 404)} />); expect(screen.getByRole('alert')).toHaveTextContent('项目不存在');
  });

  it.each(['resolve', 'reject'])('ignores a late clipboard %s after the once-only dialog closes', async (result) => {
    const copy = deferred<void>(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockReturnValue(copy.promise) } });
    const view = render(<SecretDialog kind="token" secret="once-only" onClose={vi.fn()} />);
    dialogClick('复制'); view.unmount();
    await act(async () => { if (result === 'resolve') copy.resolve(); else copy.reject(new Error('private clipboard error')); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('traps focus in both directions and restores root inert state when a dialog closes', async () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
    const view = render(<AccountPage user={user} onSignOut={vi.fn()} onIdentityMismatch={vi.fn()} />, { container: root }); await tokensTab(); click('创建令牌');
    expect(root).toHaveAttribute('inert'); const dialog = screen.getByRole('dialog'); const buttons = within(dialog).getAllByRole('button');
    buttons.at(-1)!.focus(); fireEvent.keyDown(document, { key: 'Tab' }); expect(within(dialog).getByRole('combobox', { name: '语言 / Language' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true }); expect(buttons.at(-1)).toHaveFocus();
    dialogClick('取消'); expect(root).not.toHaveAttribute('inert'); view.unmount(); root.remove();
  });
});
