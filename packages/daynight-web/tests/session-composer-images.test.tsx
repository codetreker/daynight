import { readFileSync } from 'node:fs';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SessionComposer } from '../src/features/task-agent-session/SessionComposer';
import type { ComposerAttachmentsBinding } from '../src/features/task-agent-session/ComposerAttachments';
import { emptySessionState, hydrateSession } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const setup = (text = '', ready = true, overrides: Partial<ComposerAttachmentsBinding['view']> = {}, checkableReceiptIds?: ReadonlySet<string>, visibleReceiptIds?: ReadonlySet<string>) => {
  const snapshot = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
  snapshot.controls = { revision: '1', settings: [], commands: [{ id: 'review', name: 'review', description: 'Review', argumentHint: 'Instructions', available: true }], settingsError: null, commandsError: null };
  const attachments = {
    view: { active: true, loading: false, text, revision: '1', draftId: 'draft', items: [{ draftImageId: 'image', label: 'reference.png', asset: null, progress: ready ? 100 : 0, error: ready ? null : 'Image could not be uploaded.', status: ready ? 'complete' : 'failed' }], rejectedCandidates: [], overflowRejectedCount: 0, saving: false, error: null, conflict: false, frozen: false, submission: null, canSend: ready, disabledReason: ready ? null : 'Image could not be uploaded.', checking: false },
    addFiles: vi.fn(async () => {}), remove: vi.fn(async () => {}), discardRejected: vi.fn(async () => {}), retrySave: vi.fn(async () => {}), retryUpload: vi.fn(async () => {}), checkStatus: vi.fn(async () => {}), continueEditing: vi.fn(async () => {}), resolveConflict: vi.fn(async () => {}), resolveFailure: vi.fn(async () => {}),
  };
  Object.assign(attachments.view, overrides);
  const props = { state: hydrateSession(emptySessionState(), snapshot, []), connected: true, draft: { text, revision: '1', submission: null }, onDraftChange: vi.fn(), onSend: vi.fn(async () => {}), onCancel: vi.fn(async () => {}), onExecuteCommand: vi.fn(async () => {}), attachments };
  render(<SessionComposer {...props} {...(checkableReceiptIds ? { checkableReceiptIds } : {})} {...(visibleReceiptIds ? { visibleReceiptIds } : {})} />);
  return props;
};

it.each([true, false])('keeps image recovery scoped to its original submission when a receipt is visible: %s', receiptVisible => {
  const ref = { ownerKey: 'owner', operationId: 'original', choiceRevision: '1' };
  const props = setup('retained', true, {
    frozen: true, submission: { operationId: ref.operationId },
    recoveries: [{ ref, state: 'unknown', error: null, currentOwner: true, currentExecution: true, frozen: null, successor: null, canCheck: true, canCancelPrepared: false, canResolveFailure: false }],
  }, receiptVisible ? new Set([ref.operationId]) : undefined);
  expect(screen.getByRole('button', { name: 'Continue editing' })).toBeEnabled();
  if (receiptVisible) expect(screen.queryByRole('button', { name: 'Check status' })).toBeNull();
  else {
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    expect(props.attachments.checkStatus).toHaveBeenCalledExactlyOnceWith(ref);
  }
});

it('retains the original image recovery when a terminal receipt cannot settle the local draft', () => {
  const ref = { ownerKey: 'owner', operationId: 'original', choiceRevision: '1' };
  const props = setup('retained', true, {
    frozen: true, submission: { operationId: ref.operationId },
    recoveries: [{ ref, state: 'unknown', error: 'image_draft_failed', currentOwner: true, currentExecution: true, frozen: null, successor: null, canCheck: true, canCancelPrepared: false, canResolveFailure: false }],
  }, undefined, new Set([ref.operationId]));
  fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
  expect(props.attachments.checkStatus).toHaveBeenCalledExactlyOnceWith(ref);
  expect(screen.getByRole('button', { name: 'Continue editing' })).toBeEnabled();
});

it('allows a prepared image-only message and preserves mixed-message whitespace', async () => {
  const props = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(props.onSend).toHaveBeenCalledWith(''));
});

it.each([null, 'image_session_unavailable', 'image_draft_failed'])('shows a rejected send once while retaining a distinct draft error: %s', async draftError => {
  const props = setup('retained message', true, { error: draftError });
  props.onSend.mockRejectedValue(new Error('image_session_unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  expect(props.onSend).toHaveBeenCalledOnce();
  expect(screen.getAllByRole('alert')).toHaveLength(draftError === 'image_draft_failed' ? 2 : 1);
  expect(screen.getByRole('textbox')).toHaveValue('retained message');
  expect(screen.getByText('reference.png')).toBeInTheDocument();
});

it('keeps the complete message blocked when an image failed', () => {
  const props = setup('Explain this image', false);
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(props.onSend).not.toHaveBeenCalled();
  expect(screen.getByText('reference.png')).toBeInTheDocument();
});

it('explains a disabled image profile while retaining the draft and blocking send', () => {
  const props = setup('Explain this image', true, { canSend: false, disabledReason: 'profile_disabled' });
  expect(screen.getByText('Image input is not yet available for the current model. The draft is retained; remove the images to send text.')).toBeInTheDocument();
  expect(screen.queryByText(/Check the connection/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(props.onSend).not.toHaveBeenCalled();
  expect(screen.getByText('reference.png')).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveValue('Explain this image');
});

it('keeps retry available while an unreadable saved draft blocks editing and sending', () => {
  const props = setup('retained text', false, { readOnly: true, error: 'image_draft_unavailable', items: [] });
  expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  const retry = screen.getByRole('button', { name: 'Retry saving' });
  expect(retry).toBeEnabled(); fireEvent.click(retry);
  expect(props.attachments.retrySave).toHaveBeenCalledOnce();
});

it('preserves image drafts and text when selecting a real command', () => {
  const props = setup('/review');
  fireEvent.click(screen.getByRole('option', { name: /\/review/ }));
  expect(props.onDraftChange).not.toHaveBeenCalled();
  expect(props.onExecuteCommand).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Images cannot be used with commands');
});

it('keeps an unmatched slash path as an ordinary image message with exact text', async () => {
  const props = setup('  /src/example.ts  ');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('  /src/example.ts  '));
});

it('adds pasted files in their input order and inserts plain text once at the selection', () => {
  const props = setup('before after');
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  input.setSelectionRange(7, 7);
  const files = [new File(['first'], 'first.png', { type: 'image/png' }), new File(['second'], 'second.png', { type: 'image/png' })];
  fireEvent.paste(input, { clipboardData: { files, getData: (type: string) => type === 'text/plain' ? 'image ' : '' } });
  expect(props.onDraftChange).toHaveBeenCalledWith('before image after');
  expect(props.attachments.addFiles).toHaveBeenCalledWith(files, 'before image after');
});

it('does not consume image paste or submit during IME composition', () => {
  const props = setup('draft');
  const input = screen.getByRole('textbox');
  fireEvent.compositionStart(input);
  fireEvent.paste(input, { clipboardData: { files: [new File(['image'], 'one.png', { type: 'image/png' })], getData: () => '' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(props.attachments.addFiles).not.toHaveBeenCalled();
  expect(props.onSend).not.toHaveBeenCalled();
});

it('reserves input space without counting a nested image error or resizing during observer delivery', () => {
  const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('ResizeObserver', class {
    readonly entry: typeof observers[number];
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, targets: new Set() }; observers.push(this.entry); }
    observe(target: Element) { this.entry.targets.add(target); }
    disconnect() {}
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  try {
    setup('retained draft', false);
    const surface = screen.getByRole('textbox').closest<HTMLElement>('.session-composer-surface')!;
    const input = screen.getByRole('textbox'), footer = surface.querySelector<HTMLElement>('.session-composer-footer')!;
    const nestedError = surface.querySelector<HTMLElement>('.session-draft-attachments .session-error')!;
    input.style.minHeight = '44px';
    Object.defineProperty(footer, 'offsetHeight', { configurable: true, value: 44 });
    Object.defineProperty(nestedError, 'offsetHeight', { configurable: true, value: 80 });
    const observer = observers.find(entry => entry.targets.has(surface) && entry.targets.has(footer))!;
    const before = surface.style.minHeight;
    observer.callback([], {} as ResizeObserver);
    expect(surface.style.minHeight).toBe(before);
    expect(frames).toHaveLength(1);
    frames[0]!(0);
    expect(surface.style.minHeight).toBe('88px');
  } finally { vi.unstubAllGlobals(); }
});
