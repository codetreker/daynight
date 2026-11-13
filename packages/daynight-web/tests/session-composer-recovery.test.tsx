import { fireEvent, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ComposerAttachments, type ComposerAttachmentsBinding } from '../src/features/task-agent-session/ComposerAttachments';
import type { ImageDraftRecovery } from '../src/features/task-agent-session/drafts/image-draft-controller';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const recovery = (overrides: Partial<ImageDraftRecovery> = {}): ImageDraftRecovery => ({
  ref: { ownerKey: 'earlier-owner', operationId: 'earlier-operation', choiceRevision: 'displayed-versions' },
  state: 'rejected', currentOwner: false, currentExecution: true, error: null,
  frozen: { text: 'The submitted message', items: [{ draftImageId: 'old-image', label: 'submitted.png' }] },
  successor: { text: 'The later edit', items: [{ draftImageId: 'next-image', label: 'successor.png' }] },
  canCheck: false, canCancelPrepared: false, canResolveFailure: true, ...overrides,
});
const binding = (entries: readonly ImageDraftRecovery[]): ComposerAttachmentsBinding => ({
  view: { active: true, loading: false, items: [], rejectedCandidates: [], overflowRejectedCount: 0, saving: false,
    error: null, conflict: false, frozen: false, submission: null, canSend: false, disabledReason: null, checking: false,
    recoveries: entries },
  addFiles: vi.fn(async () => {}), remove: vi.fn(async () => {}), discardRejected: vi.fn(async () => {}),
  retrySave: vi.fn(async () => {}), retryUpload: vi.fn(async () => {}), checkStatus: vi.fn(async () => {}),
  continueEditing: vi.fn(async () => {}), resolveConflict: vi.fn(async () => {}), resolveFailure: vi.fn(async () => {}),
  cancelPrepared: vi.fn(async () => {}),
});

it('shows both original drafts and confirms the displayed owner, operation and versions', () => {
  const entry = recovery(), attachments = binding([entry]);
  render(<ComposerAttachments binding={attachments} active editable />);
  expect(screen.getByText('The submitted message')).toBeInTheDocument();
  expect(screen.getByText('The later edit')).toBeInTheDocument();
  expect(screen.getByText('submitted.png')).toBeInTheDocument();
  expect(screen.getByText('successor.png')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Restore failed draft and discard later edits' }));
  expect(attachments.resolveFailure).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('group', { name: 'Confirm' })).getByRole('button', { name: 'Confirm' }));
  expect(attachments.resolveFailure).toHaveBeenCalledExactlyOnceWith(entry.ref, 'failed');
});

it('requires a new choice after a competing draft version replaces the displayed recovery', () => {
  const entry = recovery(), attachments = binding([entry]);
  const view = render(<ComposerAttachments binding={attachments} active editable />);
  fireEvent.click(screen.getByRole('button', { name: 'Keep later edits and discard failed draft' }));
  const newer = recovery({ ref: { ...entry.ref, choiceRevision: 'competing-edit' } });
  view.rerender(<ComposerAttachments binding={{ ...attachments, view: { ...attachments.view, recoveries: [newer] } }} active editable />);
  expect(screen.queryByRole('group', { name: 'Confirm' })).not.toBeInTheDocument();
  expect(attachments.resolveFailure).not.toHaveBeenCalled();
});

it('invalidates confirmation while recovery permission is unavailable', () => {
  const attachments = binding([recovery()]);
  const view = render(<ComposerAttachments binding={attachments} active editable canRecover />);
  fireEvent.click(screen.getByRole('button', { name: 'Keep later edits and discard failed draft' }));
  view.rerender(<ComposerAttachments binding={attachments} active editable canRecover={false} />);
  expect(screen.queryByRole('group', { name: 'Confirm' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Keep later edits and discard failed draft' })).toBeDisabled();
  view.rerender(<ComposerAttachments binding={attachments} active editable canRecover />);
  expect(screen.queryByRole('group', { name: 'Confirm' })).not.toBeInTheDocument();
});

it('queries a historical generation only through its original recovery reference', () => {
  const entry = recovery({ state: 'unknown', currentExecution: false, successor: null, canResolveFailure: false, canCheck: true });
  const attachments = binding([entry]);
  render(<ComposerAttachments binding={attachments} active editable />);
  fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
  expect(attachments.checkStatus).toHaveBeenCalledExactlyOnceWith(entry.ref);
  expect(screen.queryByRole('button', { name: 'Send this saved message' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Continue editing' })).not.toBeInTheDocument();
});

it('retains the displayed draft details while a recovery action is temporarily unavailable', () => {
  const entry = recovery({ currentOwner: true }), attachments = binding([entry]);
  const view = render(<ComposerAttachments binding={attachments} active editable />);
  const details = screen.getByText('The later edit').closest('details')!;
  fireEvent.click(details.querySelector('summary')!);
  view.rerender(<ComposerAttachments binding={{ ...attachments, view: { ...attachments.view, recoveries: [{ ...entry, canResolveFailure: false }] } }} active editable />);
  expect(screen.getByText('The later edit').closest('details')).toBe(details);
  expect(details).toHaveAttribute('open');
  expect(screen.getByRole('button', { name: 'Keep later edits and discard failed draft' })).toBeDisabled();
});

it('shows an earlier draft recovery error without presenting a current-draft conflict', () => {
  const attachments = binding([recovery({ error: 'image_draft_unavailable' })]);
  render(<ComposerAttachments binding={attachments} active editable />);
  expect(screen.getByRole('alert')).toHaveTextContent('The draft could not be saved');
  expect(screen.queryByRole('button', { name: 'Use saved draft' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Keep later edits and discard failed draft' })).toBeEnabled();
});

it('keeps the original query error visible for the current unknown submission', () => {
  const entry = recovery({ currentOwner: true, state: 'unknown', successor: null, canCheck: true, canResolveFailure: false, error: 'image_access_unavailable' });
  const attachments = binding([entry]);
  render(<ComposerAttachments binding={{ ...attachments, view: { ...attachments.view, submission: { operationId: entry.ref.operationId } } }} active editable />);
  expect(screen.getByRole('alert')).toHaveTextContent('Session access must be confirmed');
  expect(screen.getByRole('button', { name: 'Check status' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Use saved draft' })).not.toBeInTheDocument();
});

it('cancels a prepared original without borrowing the current owner', () => {
  const entry = recovery({ state: 'prepared', successor: null, canResolveFailure: false, canCancelPrepared: true });
  const attachments = binding([entry]);
  render(<ComposerAttachments binding={attachments} active editable />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel the pending message and keep its draft' }));
  expect(attachments.cancelPrepared).toHaveBeenCalledExactlyOnceWith(entry.ref);
  expect(attachments.resolveFailure).not.toHaveBeenCalled();
});

it('allows cancelling a current prepared command when its command is no longer available', () => {
  const entry = recovery({ currentOwner: true, state: 'prepared', successor: null, canResolveFailure: false, canCancelPrepared: true });
  const attachments = binding([entry]);
  render(<ComposerAttachments binding={{ ...attachments, view: { ...attachments.view, frozen: true,
    submission: { operationId: entry.ref.operationId }, canResumePrepared: false } }} active editable={false} canRecover />);
  expect(screen.queryByRole('button', { name: 'Send this saved message' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Check status' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel the pending message and keep its draft' }));
  expect(attachments.cancelPrepared).toHaveBeenCalledExactlyOnceWith(entry.ref);
});
