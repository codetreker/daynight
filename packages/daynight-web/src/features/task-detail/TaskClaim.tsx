import { readWorkerClaim } from "../../api/task-properties";
import type { RefObject } from 'react';
import { ApiError } from '../../api/client';
import type { ProjectMember } from '../../api/auth-types';
import type { TaskDetail, WorkerClaim } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { identityName } from '../management/feedback';
import { taskReviewKey } from './freshness';
import { TaskConfirmation } from './TaskConfirmation';
import { TaskDetailNotice, useMutationNoticeEvent } from './TaskDetailNotice';
import type { TaskMutationState } from './TaskDetailSession';

export type WithdrawalConfirmation = { readonly kind: 'withdraw'; readonly detail: TaskDetail; readonly claimId: string };
export const matchesWithdrawalReview = (confirmation: WithdrawalConfirmation, detail: TaskDetail | null): boolean =>
  detail !== null && readWorkerClaim(detail.properties)?.claimId === confirmation.claimId && taskReviewKey(confirmation.detail) === taskReviewKey(detail);

export const mayWithdrawClaim = (worker: WorkerClaim, viewerId: string, members: readonly ProjectMember[]): boolean => {
  const viewer = members.find((member) => member.userId === viewerId);
  return worker.state !== 'completed' && viewer !== undefined && (worker.userId === viewerId || viewer.role === 'admin');
};

export const TaskClaimSummary = ({ worker, members, membershipStatus, membershipError, onRetryMembers, canWithdraw, onWithdraw }: {
  readonly worker: WorkerClaim;
  readonly members: readonly ProjectMember[];
  readonly membershipStatus: 'loading' | 'ready' | 'error';
  readonly membershipError: unknown;
  readonly onRetryMembers: () => void;
  readonly canWithdraw: boolean;
  readonly onWithdraw?: () => void;
}) => {
  const { messages: { inspection: { claim: m }, common } } = useI18n();
  const member = members.find((item) => item.userId === worker.userId);
  const label = member === undefined ? worker.userId : identityName(member);
  return <section className={`task-claim task-claim-${worker.state}`} aria-label={worker.state === 'active' ? m.active : m.released}>
    <div className="task-claim-summary">
      <div className="task-claim-owner"><span className="task-claim-label">{worker.state === 'active' ? m.active : m.released}</span><strong title={worker.userId}>{label}</strong>{member !== undefined && member.email !== null && member.email !== label && <span className="task-claim-account">{member.email}</span>}{member === undefined && membershipStatus === 'ready' && <span className="task-claim-account">{m.formerMember}</span>}</div>
      <div className="task-claim-execution"><span><span className="task-claim-label">{m.machine}</span> {worker.machine.name}</span><span><span className="task-claim-label">{m.agent}</span> {worker.agent === 'codex' ? 'Codex' : worker.agent === 'claude' ? 'Claude Code' : 'Copilot'}</span><span className="task-claim-phase">{m.phase[worker.phase]}</span></div>
      {membershipStatus === 'loading' && <p className="task-claim-members" role="status">{m.membersLoading}</p>}
      {membershipStatus === 'error' && <div className="task-claim-members" role="alert"><p>{m.membersError}</p>{membershipError instanceof ApiError && membershipError.requestId !== null && <p className="request-id">{common.requestId} <code>{membershipError.requestId}</code></p>}<button className="inline-link" type="button" onClick={onRetryMembers}>{m.retryMembers}</button></div>}
    </div>
    {onWithdraw !== undefined && <button className="button task-claim-withdraw" type="button" disabled={!canWithdraw} onClick={onWithdraw}>{m.withdraw}</button>}
  </section>;
};

export const TaskWithdrawalConfirmation = ({ confirmation, ...props }: {
  readonly confirmation: WithdrawalConfirmation;
  readonly owner: RefObject<HTMLElement | null>;
  readonly fallbackFocus: RefObject<HTMLElement | null>;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) => {
  const { messages: { inspection: { claim: m, status } } } = useI18n();
  return <TaskConfirmation {...props} title={m.title} question={m.question} explanation={m.explanation} taskTitle={confirmation.detail.title}
    confirmLabel={m.withdraw} cancelLabel={status.cancel} closeLabel={status.closeConfirmation} destructive />;
};

const WithdrawalError = ({ error }: { readonly error: unknown }) => {
  const { messages: { inspection: { claim: m }, common } } = useI18n();
  const message = error instanceof ApiError ? error.kind === 'network' ? m.networkError : error.kind === 'protocol' ? m.protocolError
    : error.code === 'version_conflict' ? m.versionConflict : error.code === 'claim_conflict' ? m.claimConflict : m.refused : m.requestFailed;
  return <><p>{message}</p>{error instanceof ApiError && error.requestId !== null && <p className="request-id">{common.requestId} <code>{error.requestId}</code></p>}</>;
};

export const TaskWithdrawalFeedback = ({ mutation, onReconcile }: { readonly mutation: TaskMutationState; readonly onReconcile: () => void }) => {
  const { messages: { inspection: { claim: m } } } = useI18n();
  const relevant = mutation.operation?.action === 'withdraw';
  const event = useMutationNoticeEvent(mutation);
  const busy = relevant && (mutation.phase === 'pending' || mutation.reconciling);
  const unresolved = relevant && (mutation.phase === 'unknown' || mutation.reconciliationError !== null);
  const message = !relevant ? null : mutation.reconciling ? m.checking : mutation.phase === 'pending' ? m.pending : mutation.phase === 'confirmed' ? m.confirmed
    : mutation.phase === 'unknown' ? m.unknown : mutation.phase === 'conflict' ? m.conflict : mutation.phase === 'reconciled' ? m.reconciled : null;
  return <div aria-live="polite" aria-busy={busy}><TaskDetailNotice active={relevant && mutation.phase !== 'idle'} event={event} initiallyVisible={mutation.phase !== 'confirmed'}
    tone={mutation.phase === 'confirmed' ? 'success' : mutation.phase === 'refused' ? 'error' : unresolved || mutation.phase === 'conflict' ? 'warning' : 'info'} recoverable={unresolved}>
    {message !== null && <p role={unresolved || mutation.phase === 'conflict' ? 'alert' : 'status'}>{message}</p>}
    {unresolved && <button className="button" type="button" disabled={busy} onClick={onReconcile}>{mutation.reconciling ? m.checking : m.checkState}</button>}
    {relevant && mutation.error !== null && <div role="alert"><WithdrawalError error={mutation.error} /></div>}
    {relevant && mutation.reconciliationError !== null && <div role="alert"><p>{m.checkFailed}</p><WithdrawalError error={mutation.reconciliationError} /></div>}
  </TaskDetailNotice></div>;
};
