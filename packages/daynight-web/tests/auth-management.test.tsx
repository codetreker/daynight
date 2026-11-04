import { directAccessFixture } from "./helpers/taskSync";
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocaleRender } from './helpers/renderWithLocale';
import * as auth from '../src/api/auth';
import { messagesByLocale } from '../src/i18n/messages';
import { ApiError } from '../src/api/client';
import { AccountPage } from '../src/features/management/AccountPage';
import { MembersPanel } from '../src/features/management/MembersPanel';
import { Identity, ManagementError, SecretDialog } from '../src/features/management/feedback';
import type { CurrentUser, PersonalAccessToken, ProjectInvitation, ProjectParticipant, ProjectParticipants, ProjectGrant } from '../src/api/auth';

vi.mock('../src/api/auth', () => ({
  listTokens: vi.fn(), createToken: vi.fn(), revokeToken: vi.fn(), updateTokenExpiry: vi.fn(),
  getProjectAccess: vi.fn(), listMembers: vi.fn(), listInvitations: vi.fn(), createInvitation: vi.fn(), revokeInvitation: vi.fn(), setMemberRole: vi.fn(), removeMember: vi.fn(),
}));

const localeRender = createLocaleRender('zh-CN');
const render: typeof localeRender = (ui, options) => localeRender(ui, { taskCache: { viewerId: user.id }, ...options });
let actorRole: 'admin' | 'member' = 'admin';

const user: CurrentUser = { personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, id: '00000000-0000-4000-8000-000000000201', name: 'Jianjun', email: 'a@example.com', emailVerified: true, avatarUrl: null };
const token: PersonalAccessToken = { id: 'token-a', name: 'MacBook', createdAt: '2026-10-22T12:00:00Z', expiresAt: '2099-10-22T12:00:00Z' };
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
  await waitFor(() => expect(screen.getByRole('button', { name })).not.toBeDisabled());
  click(name);
};
const dialogClick = async (name: string) => { const button = within(screen.getByRole('dialog')).getByRole('button', { name }); await waitFor(() => expect(button).not.toBeDisabled()); fireEvent.click(button); };
const account = () => render(<AccountPage user={user} onSignOut={vi.fn()} onIdentityMismatch={vi.fn()} />);
const members = (props: Partial<Parameters<typeof MembersPanel>[0]> = {}) => render(<MembersPanel projectId="00000000-0000-4000-8000-000000000101" projectName="Very long project name" user={user} onRemoved={vi.fn()} {...props} />);
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
  actorRole = 'admin';
  vi.mocked(auth.getProjectAccess).mockImplementation(async (projectId) => directAccessFixture(projectId, user.id, actorRole));
  vi.mocked(auth.listTokens).mockResolvedValue([]);
  vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id, 'admin'), member('Alice')]));
  vi.mocked(auth.listInvitations).mockResolvedValue([]);
  vi.mocked(auth.revokeToken).mockResolvedValue();
  vi.mocked(auth.setMemberRole).mockImplementation(async (_projectId, userId, input) => { if (userId === user.id) actorRole = input.role; return member(userId, input.role).directGrant!; });
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
    fireEvent.keyDown(document, { key: 'Escape' }); fireEvent.keyDown(document, { key: 'Tab' }); expect(within(screen.getByRole('dialog')).getByRole('combobox', { name: '语言 / Language' })).toHaveFocus();
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
    await dialogClick('复制'); await screen.findByText(/浏览器未允许自动复制/);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('combobox', { name: '语言 / Language' }), { target: { value: 'en' } });
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
    const view = account(); click('访问令牌');
    const signal = vi.mocked(auth.listTokens).mock.calls[0]![0];
    view.rerender(<AccountPage user={{ ...user, id: 'new-account', name: 'New account' }} onSignOut={vi.fn()} onIdentityMismatch={vi.fn()} />);
    expect(signal.aborted).toBe(true); expect(screen.getByText('New account')).toBeInTheDocument();
    await act(async () => late.resolve([token])); expect(screen.queryByText('MacBook')).toBeNull();
  });
});

describe('authoritative project management', () => {
  it('reads regular member state without requesting administrator invitations', async () => {
    actorRole = 'member';
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id), member('Alice', 'admin')]));
    members(); await readyMembers();
    expect(screen.getByText(/成员与邀请由项目管理员管理/)).toBeInTheDocument();
    expect(auth.listInvitations).not.toHaveBeenCalled(); expect(screen.queryByRole('combobox')).toBeNull(); expect(screen.queryByRole('button', { name: '邀请成员' })).toBeNull();
    expect(screen.getByText('Very long project name · 管理协作成员与加入邀请')).toBeInTheDocument();
  });

  it('allows the last direct admin to change grants and submits the exact observed int64 version on confirmed promotion', async () => {
    const change = vi.fn(); members({ onMembershipChange: change }); await readyMembers();
    expect(screen.getByRole('combobox', { name: 'Jianjun 的项目角色' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: '移除 Jianjun' })).not.toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Alice 的项目角色' }), { target: { value: 'admin' } });
    expect(auth.setMemberRole).not.toHaveBeenCalled();
    await dialogClick('取消'); expect(screen.getByRole('combobox', { name: 'Alice 的项目角色' })).toHaveValue('member');
    fireEvent.change(screen.getByRole('combobox', { name: 'Alice 的项目角色' }), { target: { value: 'admin' } });
    await dialogClick('保存角色'); await waitFor(() => expect(change).toHaveBeenCalledOnce()); await readyMembers();
    expect(auth.setMemberRole).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000101', 'Alice', { version: 9223372036854775806n, role: 'admin', expectedUserId: user.id }, expect.any(AbortSignal), expect.any(Function));
  });

  it.each([403, 409])('reloads authoritative role after %s, hides privileged actions and does not repeat the mutation', async (status) => {
    vi.mocked(auth.listMembers).mockResolvedValueOnce(memberPage([member(user.id, 'admin'), member('Alice')])).mockResolvedValue(memberPage([member(user.id), member('Alice', 'admin')]));
    vi.mocked(auth.setMemberRole).mockImplementation(async () => { actorRole = 'member'; throw new ApiError('server', status, status === 409 ? 'conflict' : 'forbidden'); });
    members(); await readyMembers();
    fireEvent.change(screen.getByRole('combobox', { name: 'Alice 的项目角色' }), { target: { value: 'admin' } }); await dialogClick('保存角色');
    await screen.findByText(/成员与邀请由项目管理员管理/);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('combobox')).toBeNull();
    expect(auth.listInvitations).toHaveBeenCalledOnce(); expect(auth.setMemberRole).toHaveBeenCalledOnce(); expect(auth.listMembers).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent(status === 409 ? '成员状态已变化' : '项目权限已变化');
  });

  it('localizes a conflict notice and the current role without reloading network state on language change', async () => {
    vi.mocked(auth.listMembers).mockResolvedValueOnce(memberPage([member(user.id, 'admin'), member('Alice')])).mockResolvedValue(memberPage([member(user.id), member('Alice', 'admin')]));
    vi.mocked(auth.setMemberRole).mockImplementation(async () => { actorRole = 'member'; throw new ApiError('server', 409, 'conflict'); });
    members(); await readyMembers();
    fireEvent.change(screen.getByRole('combobox', { name: 'Alice 的项目角色' }), { target: { value: 'admin' } });
    const en = messagesByLocale.en.auth.management;
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('combobox', { name: '语言 / Language' }), { target: { value: 'en' } });
    expect(screen.getByRole('dialog', { name: en.members.roleTitle({ name: 'Alice' }) })).toBeInTheDocument();
    await dialogClick(en.members.saveRole);
    await screen.findByText(en.members.memberNotice);
    expect(screen.getByRole('status')).toHaveTextContent(en.members.notice.conflictReloaded);
    expect(auth.listMembers).toHaveBeenCalledTimes(2); expect(auth.listInvitations).toHaveBeenCalledOnce(); expect(auth.setMemberRole).toHaveBeenCalledOnce();
  });

  it('reloads after self-demotion and gives up its admin actions immediately', async () => {
    vi.mocked(auth.listMembers).mockResolvedValueOnce(memberPage([member(user.id, 'admin'), member('Alice', 'admin')])).mockResolvedValue(memberPage([member(user.id), member('Alice', 'admin')]));
    members(); await readyMembers();
    fireEvent.change(screen.getByRole('combobox', { name: 'Jianjun 的项目角色' }), { target: { value: 'member' } });
    expect(screen.getByText(/你通过 Team 获得的权限保持不变/)).toBeInTheDocument(); await dialogClick('保存角色');
    await screen.findByText(/成员与邀请由项目管理员管理/); expect(screen.queryByRole('button', { name: '邀请成员' })).toBeNull();
  });

  it('confirms and removes another member with its observed version, then navigates after explicit self-removal', async () => {
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id, 'admin'), member('Alice', 'admin')]));
    const removed = vi.fn(); members({ onRemoved: removed }); await readyMembers();
    click('移除 Alice'); expect(screen.getByText(/这会撤销对方的项目单独授权/)).toBeInTheDocument(); await dialogClick('移除成员');
    await waitFor(() => expect(auth.removeMember).toHaveBeenCalledOnce()); await readyMembers();
    expect(auth.removeMember).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000101', 'Alice', { version: 9223372036854775806n, expectedUserId: user.id }, expect.any(AbortSignal), expect.any(Function)); expect(removed).not.toHaveBeenCalled();
    vi.mocked(auth.removeMember).mockImplementation(async () => { vi.mocked(auth.getProjectAccess).mockRejectedValue(new ApiError('server', 404, 'not_found')); });
    click('移除 Jianjun'); expect(screen.getByText(/撤销你的项目单独授权/)).toBeInTheDocument(); await dialogClick('移除成员');
    await waitFor(() => expect(removed).toHaveBeenCalledOnce());
  });

  it('retains inherited administrator access after self-demotion', async () => {
    const changed = { ...member(user.id, 'member'), effectiveRole: 'admin' as const };
    vi.mocked(auth.setMemberRole).mockImplementation(async () => {
      vi.mocked(auth.listMembers).mockResolvedValue(memberPage([changed, member('Alice')]));
      vi.mocked(auth.getProjectAccess).mockResolvedValue({ ...directAccessFixture('00000000-0000-4000-8000-000000000101', user.id, 'admin'), teamRole: 'admin', canTransfer: true, directGrant: changed.directGrant });
      return changed.directGrant!;
    });
    members(); await readyMembers();
    fireEvent.change(screen.getByRole('combobox', { name: 'Jianjun 的项目角色' }), { target: { value: 'member' } });
    await dialogClick('保存角色'); await readyMembers();
    expect(screen.getByRole('combobox', { name: 'Jianjun 的项目角色' })).toHaveValue('member');
    expect(screen.getByRole('button', { name: '邀请成员' })).not.toBeDisabled();
    expect(auth.setMemberRole).toHaveBeenCalledOnce();
  });

  it.each(['member', 'admin'] as const)('retains inherited %s access after removing its own direct grant', async (effectiveRole) => {
    const removed = vi.fn();
    vi.mocked(auth.removeMember).mockImplementation(async () => {
      vi.mocked(auth.listMembers).mockResolvedValue(memberPage([{ ...member(user.id, effectiveRole), directGrant: null }, member('Alice')]));
      vi.mocked(auth.getProjectAccess).mockResolvedValue({ ...directAccessFixture('00000000-0000-4000-8000-000000000101', user.id, effectiveRole), teamRole: effectiveRole, canTransfer: effectiveRole === 'admin', directGrant: null });
    });
    members({ onRemoved: removed }); await readyMembers();
    click('移除 Jianjun'); await dialogClick('移除成员');
    await waitFor(() => expect(auth.listMembers).toHaveBeenCalledTimes(2)); await readyMembers();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Jianjun')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '移除 Jianjun' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Jianjun 的项目角色' })).toBeNull();
    if (effectiveRole === 'admin') expect(screen.getByRole('button', { name: '邀请成员' })).not.toBeDisabled();
    else expect(screen.queryByRole('button', { name: '邀请成员' })).toBeNull();
    expect(removed).not.toHaveBeenCalled(); expect(auth.removeMember).toHaveBeenCalledOnce();
  });

  it.each([new ApiError('network'), new ApiError('server', 500, 'internal_error'), new ApiError('protocol')])('keeps a failed access recheck visible after confirmed self-removal without replaying it: %s', async (failure) => {
    const removed = vi.fn();
    vi.mocked(auth.removeMember).mockImplementation(async () => { vi.mocked(auth.getProjectAccess).mockRejectedValue(failure); });
    members({ onRemoved: removed }); await readyMembers();
    click('移除 Jianjun'); await dialogClick('移除成员');
    await screen.findByRole('alert');
    expect(screen.queryByRole('dialog')).toBeNull(); expect(removed).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(auth.removeMember).toHaveBeenCalledOnce();
  });

  it('creates a seven-day once-only invitation and revokes it without retaining its link', async () => {
    let catalogue: readonly ProjectInvitation[] = [];
    vi.mocked(auth.listInvitations).mockImplementation(async () => catalogue);
    vi.mocked(auth.createInvitation).mockImplementation(async () => { catalogue = [invitation]; return { ...invitation, link: 'https://daynight.test/invitations#once-secret' }; });
    vi.mocked(auth.revokeInvitation).mockImplementation(async (_projectId, invitationId) => { catalogue = catalogue.filter((item) => item.id !== invitationId); });
    members(); await readyMembers(); expect(screen.getByText(/还没有有效邀请/)).toBeInTheDocument();
    click('邀请成员'); expect(screen.getByText('7 天后到期 · 单次使用 · 加入角色：成员')).toBeInTheDocument(); await dialogClick('创建邀请链接');
    await screen.findByLabelText('一次性邀请链接'); expect(auth.createInvitation).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000101', user.id, expect.any(AbortSignal), expect.any(Function));
    expect(screen.getByLabelText('一次性邀请链接')).toHaveValue('https://daynight.test/invitations#once-secret'); await dialogClick('我已保存，关闭');
    expect(screen.queryByDisplayValue(/once-secret/)).toBeNull();
    await clickWhenReady('撤销邀请 invitation-a');
    expect(screen.getByText(/这个邀请链接将立即失效/)).toBeInTheDocument(); await dialogClick('撤销邀请');
    await screen.findByText(/还没有有效邀请/); expect(auth.revokeInvitation).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000101', 'invitation-a', user.id, expect.any(AbortSignal), expect.any(Function));
  });

  it('preserves unknown invitation results and requires a fresh catalogue before another action', async () => {
    vi.mocked(auth.createInvitation).mockRejectedValueOnce(new Error('secret-link-error')).mockResolvedValueOnce({ ...invitation, id: 'invitation-b', link: 'https://example.com/invitations#secret' });
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

  it('keeps both unknown invitation revocations disabled after reading the catalogue', async () => {
    vi.mocked(auth.listInvitations).mockResolvedValue([invitation, { ...invitation, id: 'invitation-b' }]);
    vi.mocked(auth.revokeInvitation).mockRejectedValue(new ApiError('network'));
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
    expect(auth.listMembers).toHaveBeenCalledOnce(); expect(auth.listInvitations).toHaveBeenCalledOnce();
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
    const pending = deferred<ProjectGrant>(); vi.mocked(auth.setMemberRole).mockReturnValue(pending.promise);
    const change = vi.fn(); const view = members({ onMembershipChange: change }); await readyMembers();
    fireEvent.change(screen.getByRole('combobox', { name: 'Alice 的项目角色' }), { target: { value: 'admin' } }); await dialogClick('保存角色');
    const signal = vi.mocked(auth.setMemberRole).mock.calls[0]![3]; view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(member('Alice', 'admin').directGrant!)); expect(change).not.toHaveBeenCalled();
  });

  it('keeps failed loading distinct from empty data, retries, and handles project access loss', async () => {
    vi.mocked(auth.listMembers).mockRejectedValueOnce(new Error('raw database secret')).mockRejectedValueOnce(new ApiError('server', 404, 'not_found'));
    const unavailable = vi.fn(); members({ onUnavailable: unavailable }); await readyMembers();
    expect(screen.getByRole('alert')).toHaveTextContent('操作未能完成'); expect(screen.queryByText('raw database secret')).toBeNull();
    click('重试'); await waitFor(() => expect(unavailable).toHaveBeenCalledOnce()); expect(screen.getByRole('alert')).toHaveTextContent('项目不存在或你没有访问权限');
  });

  it('uses access refusal independently of roster membership, discards old project data and aborts late responses', async () => {
    vi.mocked(auth.getProjectAccess).mockRejectedValueOnce(new ApiError('server', 404, 'not_found'));
    const unavailable = vi.fn(); vi.mocked(auth.listMembers).mockResolvedValueOnce(memberPage([member('Alice', 'admin')]));
    const view = members({ onUnavailable: unavailable }); await readyMembers(); expect(unavailable).toHaveBeenCalledOnce(); expect(screen.getByRole('alert')).toHaveTextContent('项目不存在');
    vi.mocked(auth.listMembers).mockReset();
    const earlierReads = vi.mocked(auth.listMembers).mock.calls.length;
    const earlierInvitations = vi.mocked(auth.listInvitations).mock.calls.length;
    const late = deferred<ProjectParticipants>(); vi.mocked(auth.listMembers).mockReturnValueOnce(late.promise);
    view.rerender(<MembersPanel projectId="00000000-0000-4000-8000-000000000102" projectName="Different" user={user} onRemoved={vi.fn()} />);
    expect(screen.queryByText('Alice')).toBeNull();
    await waitFor(() => expect(auth.listMembers).toHaveBeenCalledTimes(earlierReads + 1));
    const signal = vi.mocked(auth.listMembers).mock.calls.at(-1)![1]; view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => late.resolve(memberPage([member(user.id, 'admin')]))); expect(auth.listInvitations).toHaveBeenCalledTimes(earlierInvitations);
  });

  it('keeps an unconfirmed removal closed and reads access loss without repeating the write', async () => {
    vi.mocked(auth.removeMember).mockRejectedValueOnce(new ApiError('server', 500, 'internal_error'));
    const unavailable = vi.fn(); members({ onUnavailable: unavailable }); await readyMembers(); click('移除 Alice'); await dialogClick('移除成员');
    await screen.findByText(/服务端未确认这次成员变更/); expect(screen.queryByRole('dialog')).toBeNull();
    expect(auth.removeMember).toHaveBeenCalledOnce();
    vi.mocked(auth.listMembers).mockRejectedValue(new ApiError('server', 404, 'not_found')); click('读取当前成员');
    await waitFor(() => expect(unavailable).toHaveBeenCalledOnce()); expect(screen.queryByRole('dialog')).toBeNull();
    expect(auth.removeMember).toHaveBeenCalledOnce();
  });
});

describe('participant grants and unconfirmed writes', () => {
  it('uses the real direct grant role and never makes a null grant writable', async () => {
    const target = { ...member('Alice'), effectiveRole: 'admin' as const };
    const inherited = { ...member('Inherited', 'admin'), directGrant: null };
    vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id, 'admin'), target, inherited]));
    members(); await readyMembers();
    expect(screen.getByRole('combobox', { name: 'Alice 的项目角色' })).toHaveValue('member');
    expect(screen.queryByRole('combobox', { name: 'Inherited 的项目角色' })).toBeNull();
    expect(screen.queryByRole('button', { name: '移除 Inherited' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Jianjun 的项目角色' })).not.toBeDisabled();
  });
  it('handles identity mismatch through the scope owner without treating it as a grant conflict', async () => {
    const mismatch = vi.fn();
    vi.mocked(auth.setMemberRole).mockImplementation(async (_projectId, _userId, _input, _signal, onMismatch) => {
      onMismatch(); throw new ApiError('server', 409, 'identity_mismatch');
    });
    render(<MembersPanel projectId="00000000-0000-4000-8000-000000000101" projectName="Private" user={user} onRemoved={vi.fn()} />, { taskCache: { viewerId: user.id, onIdentityMismatch: mismatch } });
    await readyMembers();
    fireEvent.change(screen.getByRole('combobox', { name: 'Alice 的项目角色' }), { target: { value: 'admin' } });
    await dialogClick('保存角色');
    await screen.findByText(/登录账号已变化/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/成员状态已变化/)).toBeNull();
    expect(screen.queryByText('Alice@example.com')).toBeNull();
    expect(mismatch).toHaveBeenCalledOnce(); expect(auth.setMemberRole).toHaveBeenCalledOnce();
  });
  it.each(['network', 'protocol', 'server'] as const)('closes an unconfirmed %s write and requires a new read and review', async (kind) => {
    vi.mocked(auth.setMemberRole).mockImplementation(async () => {
      vi.mocked(auth.listMembers).mockResolvedValue(memberPage([member(user.id, 'admin'), { ...member('Alice', 'admin'), directGrant: { ...member('Alice', 'admin').directGrant!, version: 9223372036854775807n } }]));
      throw new ApiError(kind, kind === 'server' ? 500 : null);
    });
    members(); await readyMembers();
    fireEvent.change(screen.getByRole('combobox', { name: 'Alice 的项目角色' }), { target: { value: 'admin' } });
    await dialogClick('保存角色');
    await screen.findByText(/服务端未确认这次成员变更/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Alice 的项目角色' })).toBeDisabled();
    click('读取当前成员');
    await screen.findByText(/原写入结果仍未确认/);
    expect(screen.getByRole('combobox', { name: 'Alice 的项目角色' })).toHaveValue('admin');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(auth.setMemberRole).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole('combobox', { name: 'Alice 的项目角色' }), { target: { value: 'member' } });
    expect(screen.getByRole('dialog')).toHaveTextContent('成员可以继续读写');
    await dialogClick('取消');
    expect(auth.setMemberRole).toHaveBeenCalledOnce();
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
    await dialogClick('复制'); view.unmount();
    await act(async () => { if (result === 'resolve') copy.resolve(); else copy.reject(new Error('private clipboard error')); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('traps focus in both directions and restores root inert state when a dialog closes', async () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
    const view = render(<AccountPage user={user} onSignOut={vi.fn()} onIdentityMismatch={vi.fn()} />, { container: root }); await tokensTab(); click('创建令牌');
    expect(root).toHaveAttribute('inert'); const dialog = screen.getByRole('dialog'); const buttons = within(dialog).getAllByRole('button');
    buttons.at(-1)!.focus(); fireEvent.keyDown(document, { key: 'Tab' }); expect(within(dialog).getByRole('combobox', { name: '语言 / Language' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true }); expect(buttons.at(-1)).toHaveFocus();
    await dialogClick('取消'); expect(root).not.toHaveAttribute('inert'); view.unmount(); root.remove();
  });
});
