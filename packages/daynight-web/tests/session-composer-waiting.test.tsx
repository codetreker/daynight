import { readFileSync } from 'node:fs';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot, TimelineEntry } from '../src/api/types';
import { SessionComposer } from '../src/features/task-agent-session/SessionComposer';
import { emptySessionState, hydrateSession } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';

const request: TimelineEntry = {
  entryId: 'approval-entry', entrySeq: '1', revision: '1', kind: 'interaction',
  interaction: { interactionId: 'approval', revision: '1', state: 'pending', kind: 'approval', title: 'Approve Write', detail: 'notes/review.txt', actions: ['allow_once', 'reject'] },
};
function fixture(provider: 'claude' | 'codex' | 'copilot' = 'claude') {
  const original = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')) as SessionSnapshot;
  const snapshot: SessionSnapshot = { ...original, activity: 'waiting_input', currentTurnId: 'turn', identity: { ...original.identity, provider }, operations: { ...original.operations, canSend: false, canRespond: true, canCancel: true } };
  return { state: hydrateSession(emptySessionState(), snapshot, [request]), connected: true, authPaused: false, onSend: vi.fn(async () => {}), onCancel: vi.fn(async () => {}) };
}

describe.each(['en', 'zh-CN'] as const)('waiting interaction notice in %s', locale => {
  const render = createLocaleRender(locale);
  const readOnly = locale === 'en' ? 'This session is read-only.' : '此会话为只读。';
  it.each(['claude', 'codex', 'copilot'] as const)('does not describe an answerable %s approval as read-only or change input gates', provider => {
    const props = fixture(provider);
    render(<SessionComposer {...props} />);
    expect(screen.queryByText(readOnly)).toBeNull();
    expect(document.querySelector('.session-notice')).toBeNull();
    expect(screen.getByText('Waiting for an answer')).toBeVisible();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'retain this draft' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(input).toHaveValue('retain this draft');
    expect(props.onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Interrupt' })).toBeEnabled();
  });
  it.each(['archived', 'permission', 'capability', 'auth', 'no-request', 'resolved', 'stopped'] as const)('retains the existing read-only notice for %s', mode => {
    const props = fixture();
    const s = props.state.snapshot!;
    if (mode === 'archived') props.state = { ...props.state, snapshot: { ...s, lifecycle: 'archived' } };
    if (mode === 'permission') props.state = { ...props.state, snapshot: { ...s, operations: { ...s.operations, canRespond: false } } };
    if (mode === 'capability') props.state = { ...props.state, snapshot: { ...s, capabilities: { ...s.capabilities, respond: false } } };
    if (mode === 'auth') props.authPaused = true;
    if (mode === 'no-request') props.state = { ...props.state, entries: [] };
    if (mode === 'resolved' && request.kind === 'interaction') props.state = { ...props.state, entries: [{ ...request, interaction: { ...request.interaction, state: 'resolved' } }] };
    if (mode === 'stopped') props.state = { ...props.state, snapshot: { ...s, activity: 'stopped' } };
    render(<SessionComposer {...props} />);
    expect(screen.getByText(readOnly)).toBeVisible();
  });
  it.each(['sync', 'initial', 'setting'] as const)('preserves the higher priority %s notice', mode => {
    const props = fixture();
    if (mode === 'sync') props.connected = false;
    if (mode === 'initial') props.state = { ...props.state, snapshot: { ...props.state.snapshot!, initialInputState: 'unknown' } };
    if (mode === 'setting') props.state = { ...props.state, operations: new Map([['setting', { protocol: 'daynight.session.v1', sessionId: props.state.snapshot!.sessionId, claimId: 'claim', executionGeneration: '1', operationId: 'setting', kind: 'update_setting', state: 'unknown', providerResult: null, error: null }]]) };
    render(<SessionComposer {...props} />);
    expect(screen.queryByText(readOnly)).toBeNull();
    expect(document.querySelector('.session-notice')).not.toBeNull();
  });
});
