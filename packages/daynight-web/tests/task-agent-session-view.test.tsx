import type { TaskSessionSnapshot } from './helpers/session';
import { readFileSync } from 'node:fs';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionComposer } from '../src/features/task-agent-session/SessionComposer';
import { SessionTimeline } from '../src/features/task-agent-session/SessionTimeline';
import { emptySessionState, hydrateSession, sessionRespondGate } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';
import type { SessionSnapshot } from '../src/api/types';
const render = createLocaleRender('en');
const snapshot = (): TaskSessionSnapshot => JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
describe('task session composer and timeline', () => {
  it('does not send an IME confirmation and preserves newer edits while an input is pending', async () => {
    let resolve!: () => void;
    const send = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const state = hydrateSession(emptySessionState(), { ...snapshot(), activity: 'idle' }, []);
    render(<SessionComposer state={state} connected onSend={send} onCancel={async () => {}} />);
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'first' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).toHaveBeenCalledWith('first');
    fireEvent.change(input, { target: { value: 'second draft' } });
    resolve();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(input).toHaveValue('second draft');
  });
  it('retains failed text and blocks Claude working and unknown initial input', async () => {
    const send = vi.fn(async () => { throw new Error('Rejected by provider'); });
    const state = hydrateSession(emptySessionState(), { ...snapshot(), activity: 'idle' }, []);
    const view = render(<SessionComposer state={state} connected onSend={send} onCancel={async () => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'retain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Rejected by provider');
    expect(screen.getByRole('textbox')).toHaveValue('retain');
    view.rerender(<SessionComposer state={{ ...state, snapshot: { ...state.snapshot!, activity: 'working', capabilities: { ...state.snapshot!.capabilities, steer: false } } }} connected onSend={send} onCancel={async () => {}} />);
    expect(screen.getByRole('button', { name: 'Add to current turn' })).toBeDisabled();
    expect(screen.getByText('This provider cannot accept input during the current turn.')).toBeVisible();
  });
  it('renders typed content and hides unsafe Markdown resource URLs', async () => {
    const state = hydrateSession(emptySessionState(), snapshot(), [
      { entryId: 'message', entrySeq: '1', revision: '1', kind: 'assistant_message', content: [{ type: 'text', text: '**Hello** [local](file:///etc/passwd) ![tracking](https://evil.example/track)' }] },
      { entryId: 'tool', entrySeq: '2', revision: '1', kind: 'tool_call', callId: 'call', name: 'shell', input: 'pwd', output: [{ type: 'text', text: 'result' }], status: 'completed', truncated: true },
    ]);
    const view = render(<SessionTimeline state={state} active canRespond={false} onRespond={async () => {}} hasOlder={false} loadingOlder={false} onLoadOlder={async () => {}} onLoadResource={async () => new Blob()} />);
    expect(screen.getByText('Hello').tagName).toBe('STRONG');
    expect(view.container.querySelector('[href^="file:"]')).toBeNull();
    expect(view.container.querySelector('[src^="https://evil"]')).toBeNull();
    expect(screen.getByText('shell')).toBeVisible();
    const tool = screen.getByText('shell').closest('details')!; tool.open = true; fireEvent(tool, new Event('toggle'));
    expect(await screen.findByText(/Output is truncated/)).toBeInTheDocument();
  });
});


it('keeps a follow-up form enabled while the original approval card awaits its native receipt', () => {
  const original = snapshot(), s = { ...original, operations: { ...original.operations, canRespond: true } };
  const state = { ...hydrateSession(emptySessionState(), s, [
    { entryId: 'approval', entrySeq: '1', revision: '1', kind: 'interaction', interaction: { interactionId: 'approval', revision: '1', state: 'pending', kind: 'approval', title: 'Run', detail: 'Start MCP tool', actions: ['allow_once'] } },
    { entryId: 'form', entrySeq: '2', revision: '1', kind: 'interaction', interaction: { interactionId: 'form', revision: '1', state: 'pending', kind: 'form', title: 'MCP answer', canDismiss: false, fields: [{ fieldId: 'name', label: 'Name', type: 'text', required: true, sensitive: false }] } },
  ]), operations: new Map([['pending', { protocol: s.protocol, sessionId: s.sessionId, claimId: s.claimId, executionGeneration: s.executionGeneration, operationId: 'pending', kind: 'interaction_response' as const, state: 'unknown' as const, providerResult: null, error: null }]]), responseTargets: new Map([['pending', { interactionId: 'approval', revision: '1' }]]) };
  render(<SessionTimeline state={state} active canRespond={sessionRespondGate(state, true)} onRespond={async () => {}} hasOlder={false} loadingOlder={false} onLoadOlder={async () => {}} onLoadResource={async () => new Blob()} />);
  expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled();
  expect(screen.getByLabelText('Name')).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
});

it('enables only the current trusted cleanup approval in the draining timeline', () => {
  const s = snapshot();
  const state = hydrateSession(emptySessionState(), { ...s, lifecycle: 'draining', cleanupInteractionIds: ['cleanup'], operations: { ...s.operations, canRespond: true } }, [
    { kind: 'interaction', entryId: 'old', entrySeq: '1', revision: '1', interaction: { interactionId: 'old', revision: '1', kind: 'approval', state: 'pending', title: 'Old operation', detail: 'Old approval', actions: ['allow_once'] } },
    { kind: 'interaction', entryId: 'cleanup', entrySeq: '2', revision: '1', interaction: { interactionId: 'cleanup', revision: '1', kind: 'approval', state: 'pending', title: 'Cleanup operation', detail: 'Cleanup approval', actions: ['allow_once'] } },
  ]);
  render(<SessionTimeline state={state} active canRespond={sessionRespondGate(state, true)} onRespond={async () => {}} hasOlder={false} loadingOlder={false} onLoadOlder={async () => {}} onLoadResource={async () => new Blob()} />);
  const actions = screen.getAllByRole('button', { name: 'Allow once' });
  expect(actions[0]).toBeDisabled(); expect(actions[1]).toBeEnabled();
});

it('grows and shrinks the composer to its content within its measured limit', () => {
  const state = hydrateSession(emptySessionState(), { ...snapshot(), activity: 'idle' }, []);
  render(<SessionComposer state={state} connected onSend={async () => {}} onCancel={async () => {}} />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  input.style.maxHeight = '180px';
  Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 150 });
  fireEvent.change(input, { target: { value: 'multiple\nlines' } });
  expect(input.style.height).toBe('150px');
  Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 300 });
  fireEvent.change(input, { target: { value: 'longer\ntext\ncontent' } });
  expect(input.style.height).toBe('180px');
  Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 50 });
  fireEvent.change(input, { target: { value: 'short' } });
  expect(input.style.height).toBe('50px');
});

it.each([false, true])('restores send-button focus only while the user has not moved to another control (moved=%s)', async (moved) => {
  let done!: () => void;
  const state = hydrateSession(emptySessionState(), { ...snapshot(), activity: 'idle' }, []);
  render(<><SessionComposer state={state} connected onSend={() => new Promise<void>(resolve => { done = resolve; })} onCancel={async () => {}} /><input aria-label="Approval answer" /></>);
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: 'hello' } });
  const button = screen.getByRole('button', { name: 'Send' }); button.focus(); fireEvent.click(button);
  const other = screen.getByRole('textbox', { name: 'Approval answer' });
  if (moved) other.focus();
  done();
  await waitFor(() => expect(input).toHaveValue(''));
  expect(moved ? other : input).toHaveFocus();
});

it('does not refocus a composer hidden while its send is pending', async () => {
  let done!: () => void;
  const send = () => new Promise<void>(resolve => { done = resolve; });
  const state = hydrateSession(emptySessionState(), { ...snapshot(), activity: 'idle' }, []);
  const view = render(<SessionComposer state={state} connected active onSend={send} onCancel={async () => {}} />);
  const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: 'hello' } });
  const button = screen.getByRole('button', { name: 'Send' }); button.focus(); fireEvent.click(button);
  view.rerender(<SessionComposer state={state} connected active={false} onSend={send} onCancel={async () => {}} />);
  done(); await waitFor(() => expect(input).toHaveValue(''));
  expect(input).not.toHaveFocus();
});

it('keeps the composer and draft stable during identity verification without reporting a connection recovery', () => {
  const state = hydrateSession(emptySessionState(), { ...snapshot(), activity: 'idle' }, []);
  const onSend = vi.fn(async () => {}), onCancel = vi.fn(async () => {});
  const view = render(<SessionComposer state={state} connected onSend={onSend} onCancel={onCancel} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'preserve this draft' } });
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  view.rerender(<SessionComposer state={state} connected authPaused onSend={onSend} onCancel={onCancel} />);
  expect(screen.getByRole('textbox')).toBe(input);
  expect(input).toHaveValue('preserve this draft');
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(screen.queryByText('Restoring session')).toBeNull();
  expect(screen.queryByText('This session is read-only.')).toBeNull();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSend).not.toHaveBeenCalled();
  view.rerender(<SessionComposer state={state} connected onSend={onSend} onCancel={onCancel} />);
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  expect(input).toHaveValue('preserve this draft');
});
