import { fireEvent, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ComposerAttachments, type ComposerAttachmentsBinding } from '../src/features/task-agent-session/ComposerAttachments';
import type { ImageDraftDetached } from '../src/features/task-agent-session/drafts/image-draft-controller';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const detached = (overrides: Partial<ImageDraftDetached> = {}): ImageDraftDetached => ({
  ref: { ownerKey: 'earlier-owner', accessEpoch: 1, draftId: 'earlier-draft', revision: '2', storeVersion: 3,
    targetOwnerKey: 'current-owner', targetAccessEpoch: 1, targetDraftId: 'current-draft', targetRevision: '1', targetStoreVersion: 1, pendingWriteId: null },
  target: { serverOrigin: 'https://daynight.test', actorUserId: 'actor', expectedNativeSessionId: null,
    fence: { sessionId: 'session', claimId: 'claim', executionGeneration: '1' } },
  draft: { text: 'Saved after the original message', items: [{ draftImageId: 'first', label: 'first.png' }, { draftImageId: 'second', label: 'second.png' }] },
  rejectedCandidates: [{ id: 'rejected', label: 'unsupported.txt', error: 'image_format_unsupported' }], overflowRejectedCount: 2,
  canRestore: true, canRetrySave: false, canResolveConflict: false, savedDraft: null, disabledReason: null, error: null, ...overrides,
});
const binding = (entries: readonly ImageDraftDetached[]): ComposerAttachmentsBinding => ({
  view: { active: true, loading: false, items: [], rejectedCandidates: [], overflowRejectedCount: 0, saving: false,
    error: null, conflict: false, frozen: false, submission: null, canSend: false, disabledReason: null, checking: false,
    recoveries: [], detachedDrafts: entries },
  addFiles: vi.fn(async () => {}), remove: vi.fn(async () => {}), discardRejected: vi.fn(async () => {}),
  retrySave: vi.fn(async () => {}), retryUpload: vi.fn(async () => {}), checkStatus: vi.fn(async () => {}),
  continueEditing: vi.fn(async () => {}), resolveConflict: vi.fn(async () => {}), resolveFailure: vi.fn(async () => {}),
  restoreDetached: vi.fn(async () => {}),
  retryDetachedSave: vi.fn(async () => {}),
  resolveDetachedConflict: vi.fn(async () => {}),
});

it('keeps settled-owner text, image order and rejected candidates visible with an explicit move confirmation', () => {
  const entry = detached(), attachments = binding([entry]);
  render(<ComposerAttachments binding={attachments} active editable />);
  expect(screen.getByText('Saved after the original message')).toBeInTheDocument();
  expect(screen.getAllByRole('listitem', { hidden: true }).map(node => node.textContent)).toEqual([
    'first.png', 'second.png', expect.stringContaining('unsupported.txt'),
  ]);
  expect(screen.getByText('Additional images not added: 2')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Move to current draft' }));
  expect(attachments.restoreDetached).not.toHaveBeenCalled();
  const confirmation = screen.getByRole('group', { name: 'Confirm' });
  expect(confirmation).toHaveTextContent('Images will be prepared again. This does not send the message.');
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirm' }));
  expect(attachments.restoreDetached).toHaveBeenCalledExactlyOnceWith(entry.ref);
});

it.each(['source', 'target'] as const)('invalidates a move confirmation when the displayed %s draft changes', changed => {
  const entry = detached(), attachments = binding([entry]);
  const view = render(<ComposerAttachments binding={attachments} active editable />);
  fireEvent.click(screen.getByRole('button', { name: 'Move to current draft' }));
  const ref = changed === 'source' ? { ...entry.ref, revision: '3', storeVersion: 4 } : { ...entry.ref, targetRevision: '3', targetStoreVersion: 4 };
  view.rerender(<ComposerAttachments binding={binding([{ ...entry, ref }])} active editable />);
  expect(screen.queryByRole('group', { name: 'Confirm' })).not.toBeInTheDocument();
  expect(attachments.restoreDetached).not.toHaveBeenCalled();
});

it('cancels the move without consuming the retained draft', () => {
  const attachments = binding([detached()]);
  render(<ComposerAttachments binding={attachments} active editable />);
  fireEvent.click(screen.getByRole('button', { name: 'Move to current draft' }));
  fireEvent.click(within(screen.getByRole('group', { name: 'Confirm' })).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('group', { name: 'Confirm' })).not.toBeInTheDocument();
  expect(attachments.restoreDetached).not.toHaveBeenCalled();
  expect(screen.getByText('Saved after the original message')).toBeInTheDocument();
});

it('preserves expanded saved content during permission checks and clears the pending confirmation', () => {
  const entry = detached(), attachments = binding([entry]);
  const view = render(<ComposerAttachments binding={attachments} active editable canRecover />);
  const details = screen.getByText('Saved after the original message').closest('details')!;
  fireEvent.click(details.querySelector('summary')!);
  fireEvent.click(screen.getByRole('button', { name: 'Move to current draft' }));
  view.rerender(<ComposerAttachments binding={attachments} active editable canRecover={false} />);
  expect(screen.getByText('Saved after the original message').closest('details')).toBe(details);
  expect(details).toHaveAttribute('open');
  expect(screen.queryByRole('group', { name: 'Confirm' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Move to current draft' })).toBeDisabled();
  view.rerender(<ComposerAttachments binding={attachments} active editable canRecover />);
  expect(screen.queryByRole('group', { name: 'Confirm' })).not.toBeInTheDocument();
});

it('explains why an occupied current draft cannot be replaced and keeps recovery errors local', () => {
  const attachments = binding([detached({ canRestore: false, disabledReason: 'image_restore_requires_empty', error: 'image_draft_conflict' })]);
  render(<ComposerAttachments binding={attachments} active editable />);
  expect(screen.getByRole('button', { name: 'Move to current draft' })).toBeDisabled();
  expect(screen.getByText('Send or clear the current draft before moving this saved draft.')).toHaveAttribute('tabindex', '0');
  expect(screen.getByRole('alert')).toHaveTextContent('This draft changed in another window');
  expect(screen.queryByRole('button', { name: 'Replace with this window’s draft' })).not.toBeInTheDocument();
});

it('retries a failed earlier-owner save without moving it into the current input', () => {
  const entry = detached({ canRestore: false, canRetrySave: true, disabledReason: 'image_draft_unsaved', error: 'image_draft_unavailable' });
  const attachments = binding([entry]);
  const view = render(<ComposerAttachments binding={attachments} active editable canRecover />);
  expect(screen.getByText('Saved after the original message')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Move to current draft' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving this draft' }));
  expect(attachments.retryDetachedSave).toHaveBeenCalledExactlyOnceWith(entry.ref);
  expect(attachments.restoreDetached).not.toHaveBeenCalled();
  view.rerender(<ComposerAttachments binding={attachments} active editable canRecover={false} />);
  expect(screen.getByRole('button', { name: 'Retry saving this draft' })).toBeDisabled();
});

it.each(['saved', 'local'] as const)('compares both earlier-owner versions and confirms the %s conflict choice', choice => {
  const entry = detached({ canRestore: false, canResolveConflict: true, disabledReason: 'image_draft_conflict', error: 'image_draft_conflict',
    savedDraft: { text: 'Committed in another window', items: [{ draftImageId: 'saved', label: 'saved.png' }] } });
  const attachments = binding([entry]);
  render(<ComposerAttachments binding={attachments} active editable />);
  expect(screen.getByText('Saved after the original message')).toBeInTheDocument();
  expect(screen.getByText('Committed in another window')).toBeInTheDocument();
  expect(screen.getByText('saved.png')).toBeInTheDocument();
  const label = choice === 'saved' ? 'Keep saved version and discard unsaved changes' : 'Replace saved version with retained changes';
  fireEvent.click(screen.getByRole('button', { name: label }));
  expect(attachments.resolveDetachedConflict).not.toHaveBeenCalled();
  const confirm = screen.getByRole('group', { name: 'Confirm' });
  expect(confirm).toHaveTextContent(label);
  fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
  expect(attachments.resolveDetachedConflict).toHaveBeenCalledExactlyOnceWith(entry.ref, choice);
  expect(attachments.restoreDetached).not.toHaveBeenCalled();
});

it('invalidates an earlier conflict confirmation when its retained contents change', () => {
  const entry = detached({ canRestore: false, canResolveConflict: true, savedDraft: { text: 'Saved version', items: [] } });
  const attachments = binding([entry]);
  const view = render(<ComposerAttachments binding={attachments} active editable />);
  fireEvent.click(screen.getByRole('button', { name: 'Replace saved version with retained changes' }));
  view.rerender(<ComposerAttachments binding={binding([{ ...entry, ref: { ...entry.ref, pendingWriteId: 'new-retained-contents' } }])} active editable />);
  expect(screen.queryByRole('group', { name: 'Confirm' })).not.toBeInTheDocument();
  expect(attachments.resolveDetachedConflict).not.toHaveBeenCalled();
});
