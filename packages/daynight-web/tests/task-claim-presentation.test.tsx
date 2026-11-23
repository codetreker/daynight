import { fireEvent, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { ProjectParticipant } from '../src/api/auth-types';
import type { TaskDetail, WorkerClaim } from '../src/api/types';
import { mayWithdrawClaim, matchesWithdrawalReview, TaskClaimSummary, TaskWithdrawalConfirmation, TaskWithdrawalFeedback } from '../src/features/task-detail/TaskClaim';
import type { TaskMutationState } from '../src/features/task-detail/TaskDetailSession';
import { TaskDetailNotifications } from '../src/features/task-detail/TaskDetailNotice';
import { renderWithLocale } from './helpers/renderWithLocale';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const timestamp = '2026-10-27T00:00:00Z';
const worker: WorkerClaim = { claimId: id(2), state: 'active', userId: id(3), workerId: id(4), machine: { id: id(5), name: 'macmini.local' }, platform: 'macos', agent: 'codex', agentControlMode: 'herdr', worktreeId: id(6), phase: 'paused', herdr: null, nativeSessionId: null, claimedAt: timestamp };
const member = (userId = worker.userId, role: ProjectParticipant['effectiveRole'] = 'member'): ProjectParticipant => ({ inheritedFrom: null, userId, profile: { name: 'Jianjun', email: 'jianjun@example.com', avatarUrl: null }, effectiveRole: role, directGrant: { projectId: id(100), userId, role, version: 1n, createdAt: timestamp, updatedAt: timestamp } });
const detail: TaskDetail = { tags: [], type: 'task', parentId: null, assignedTo: null, id: id(1), projectId: id(100), title: 'Claimed task', description: '', status: 'in_progress', version: 4n, allowAgents: true, requiredPlatform: null, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false, startedAt: timestamp, completedAt: null, cancelledAt: null, properties: { worker, pullRequests: [] }, createdAt: timestamp, updatedAt: timestamp };
const idle: TaskMutationState = { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null };
const operation = { action: 'withdraw' as const, claimId: worker.claimId, version: detail.version };

describe('claim ownership presentation', () => {
  it('only offers withdrawal to a current member with live access who owns the claim or administers the project', () => {
    expect(mayWithdrawClaim(worker, worker.userId, "member")).toBe(true);
    expect(mayWithdrawClaim(worker, id(10), "admin")).toBe(true);
    expect(mayWithdrawClaim(worker, id(10), "member")).toBe(false);
    expect(mayWithdrawClaim(worker, worker.userId, null)).toBe(false);
    expect(mayWithdrawClaim({ ...worker, state: 'completed' }, worker.userId, "member")).toBe(false);
  });

  it('shows owner, account, machine, agent and localized execution phase without changing the saved claim', () => {
    const withdraw = vi.fn();
    const view = renderWithLocale(<TaskClaimSummary worker={worker} members={[member()]} membershipStatus="ready" membershipError={null} onRetryMembers={vi.fn()} canWithdraw onWithdraw={withdraw} />, { locale: 'en' });
    expect(screen.getByRole('region', { name: 'Claimed by' })).toHaveTextContent('Jianjun');
    expect(screen.getByText('jianjun@example.com')).toBeVisible();
    expect(screen.getByText(/macmini.local/)).toBeVisible();
    expect(screen.getByText(/Codex/)).toBeVisible();
    expect(screen.getByText('Paused')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Force withdraw' }));
    expect(withdraw).toHaveBeenCalledOnce();
    expect(worker.state).toBe('active');
    view.setLocale('zh-CN');
    expect(screen.getByRole('region', { name: '当前认领' })).toHaveTextContent('已暂停');
    expect(screen.getByRole('button', { name: '强制撤回' })).toBeVisible();
  });

  it.each([['copilot', 'Copilot'], ['claude', 'Claude Code']] as const)('represents active %s claims and former owners by their actual identity', (agent, label) => {
    renderWithLocale(<TaskClaimSummary worker={{ ...worker, state: 'active', agent }} members={[]} membershipStatus="ready" membershipError={null} onRetryMembers={vi.fn()} canWithdraw={false} />, { locale: 'en' });
    expect(screen.getByRole('region', { name: 'Claimed by' })).toHaveTextContent(worker.userId);
    expect(screen.getByText('Former project member')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Claimed by' })).toHaveTextContent(label);
    expect(screen.queryByRole('button', { name: 'Force withdraw' })).toBeNull();
  });

  it('keeps unresolved member information visible and exposes a read-only retry', () => {
    const retry = vi.fn();
    const view = renderWithLocale(<TaskClaimSummary worker={worker} members={[]} membershipStatus="loading" membershipError={null} onRetryMembers={retry} canWithdraw={false} />, { locale: 'en' });
    expect(screen.getByRole('status')).toHaveTextContent('Loading claim owner details');
    expect(screen.getByRole('status')).not.toHaveTextContent(/permissions/i);
    expect(screen.queryByText('Former project member')).toBeNull();
    view.rerender(<TaskClaimSummary worker={worker} members={[]} membershipStatus="error" membershipError={new ApiError('server', 503, 'unavailable', 'claim-members')} onRetryMembers={retry} canWithdraw={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent('claim-members');
    expect(screen.getByRole('alert')).not.toHaveTextContent(/permissions/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry member details' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each(['en', 'zh-CN'] as const)('offers a separate document for an unreadable profile response without replacing the current page (%s)', (locale) => {
    const url = `/projects/${detail.projectId}/tasks/${detail.id}?tab=discussion`;
    const retry = vi.fn();
    const view = renderWithLocale(<TaskClaimSummary worker={worker} members={[]} membershipStatus="error" membershipError={new ApiError('protocol', 200, 'protocol', 'profile-response')} onRetryMembers={retry} canWithdraw onWithdraw={vi.fn()} profileRecoveryUrl={url} />, { locale });
    const alert = screen.getByRole('alert');
    expect(alert).not.toHaveTextContent(/permissions|撤回权限/);
    expect(alert).toHaveTextContent(locale === 'en' ? 'cannot be read by this page' : '当前页面无法读取');
    expect(alert).toHaveTextContent(locale === 'en' ? 'drafts stay in this tab' : '草稿保留在此标签页');
    const recovery = within(alert).getByRole('link', { name: locale === 'en' ? 'Open task in a new tab' : '在新标签页打开任务' });
    expect(recovery).toHaveAttribute('href', url);
    expect(recovery).toHaveAttribute('target', '_blank');
    expect(recovery).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('button', { name: locale === 'en' ? 'Force withdraw' : '强制撤回' })).toBeEnabled();
    expect(retry).not.toHaveBeenCalled();
    view.rerender(<TaskClaimSummary worker={worker} members={[]} membershipStatus="error" membershipError={new ApiError('network')} onRetryMembers={retry} canWithdraw={false} profileRecoveryUrl={url} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('alert')).not.toHaveTextContent(/permissions|撤回权限/);
  });

  it.each([
    { name: null, email: 'owner@example.test', label: 'owner@example.test' },
    { name: 'Owner name', email: null, label: 'Owner name' },
    { name: null, email: null, label: worker.userId },
  ])('preserves nullable participant owner profiles without treating them as former: $label', ({ name, email, label }) => {
    const owner = { ...member(), profile: { name, email, avatarUrl: null } };
    renderWithLocale(<TaskClaimSummary worker={worker} members={[owner]} membershipStatus="ready" membershipError={null} onRetryMembers={vi.fn()} canWithdraw={false} />, { locale: 'en' });
    expect(screen.getByText(label, { selector: 'strong' })).toBeVisible();
    expect(screen.queryByText('Former project member')).toBeNull();
  });

  it('invalidates withdrawal confirmation when the claim or reviewed version changes', () => {
    const confirmation = { kind: 'withdraw' as const, detail, claimId: worker.claimId };
    expect(matchesWithdrawalReview(confirmation, detail)).toBe(true);
    expect(matchesWithdrawalReview(confirmation, null)).toBe(false);
    expect(matchesWithdrawalReview(confirmation, { ...detail, version: detail.version + 1n })).toBe(false);
    expect(matchesWithdrawalReview(confirmation, { ...detail, properties: { ...detail.properties, worker: { ...worker, claimId: id(20) } } })).toBe(false);
  });

  it('explains reset and delayed remote cleanup and restores focus on cancellation', () => {
    const owner = createRef<HTMLElement>();
    const fallback = createRef<HTMLHeadingElement>();
    const cancel = vi.fn(); const confirm = vi.fn();
    const view = renderWithLocale(<><section ref={owner}><h2 ref={fallback} tabIndex={-1}>Details</h2><button>Withdraw trigger</button></section><TaskWithdrawalConfirmation confirmation={{ kind: 'withdraw', detail, claimId: worker.claimId }} owner={owner} fallbackFocus={fallback} onCancel={cancel} onConfirm={confirm} /></>, { locale: 'en' });
    const dialog = screen.getByRole('alertdialog', { name: 'Force withdraw this task?' });
    expect(within(dialog).getByText(/clears the claim and execution times and disables automatic execution/)).toBeVisible();
    expect(dialog).toHaveTextContent('cannot guarantee an immediate stop');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Force withdraw' }));
    expect(confirm).toHaveBeenCalledOnce();
    view.unmount();
  });
});

describe('withdrawal feedback', () => {
  it('retains unknown outcomes and read failures with a check action that never replays withdrawal', () => {
    const onReconcile = vi.fn();
    const fallback = createRef<HTMLElement>();
    const mutation: TaskMutationState = { ...idle, operation, phase: 'unknown', error: new ApiError('network', null, 'network', 'withdraw-unknown'), reconciliationError: new ApiError('protocol', 200, 'protocol', 'withdraw-read') };
    const view = renderWithLocale(<TaskDetailNotifications fallbackFocus={fallback}><TaskWithdrawalFeedback mutation={mutation} onReconcile={onReconcile} /></TaskDetailNotifications>, { locale: 'en' });
    expect(screen.getByText('withdraw-unknown')).toBeVisible();
    expect(screen.getByText('withdraw-read')).toBeVisible();
    expect(screen.getByText('No confirmed withdrawal response was received.')).toBeVisible();
    expect(screen.getByText('The service response could not confirm the withdrawal result.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Check current task' }));
    expect(onReconcile).toHaveBeenCalledOnce();
    view.rerender(<TaskDetailNotifications fallbackFocus={fallback}><TaskWithdrawalFeedback mutation={{ ...mutation, reconciling: true }} onReconcile={onReconcile} /></TaskDetailNotifications>);
    expect(screen.getByRole('button', { name: 'Checking the current task…' })).toBeDisabled();
  });
});
