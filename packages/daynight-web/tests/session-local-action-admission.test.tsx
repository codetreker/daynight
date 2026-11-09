import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionControls } from '../../daynight/src/session/controls';
import { sessionFence } from '../../daynight/src/session/protocol';
import type { SessionInteraction, SessionOperation, SessionSnapshot, TimelineEntry } from '../src/api/types';
import type { TaskSessionClient, SessionViewState } from '../src/features/task-agent-session/client';
import { SessionComposer } from '../src/features/task-agent-session/SessionComposer';
import { SessionInteractionCard } from '../src/features/task-agent-session/SessionInteractionCard';
import { SessionTimeline } from '../src/features/task-agent-session/SessionTimeline';
import { SessionView } from '../src/features/task-agent-session/SessionView';
import { emptySessionState, hydrateSession } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const controls: SessionControls = {
  revision: '3', settings: [{ id: 'model', category: 'model', label: 'Model', description: null, value: 'a', mutable: true, scope: 'session', options: [{ value: 'a', label: 'Model A' }, { value: 'b', label: 'Model B' }] }],
  commands: [{ id: 'compact', name: 'compact', description: 'Compact context', argumentHint: null, available: true }, { id: 'review', name: 'review', description: 'Review changes', argumentHint: 'Review instructions', available: true }],
  settingsError: null, commandsError: null,
};
const snapshot = (): SessionSnapshot => ({ ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), controls, turnStartedAt: null });
const composerProps = () => ({ state: hydrateSession(emptySessionState(), snapshot(), []), connected: true, onSend: vi.fn(async () => {}), onCancel: vi.fn(async () => {}), onUpdateSetting: vi.fn(async () => {}), onExecuteCommand: vi.fn(async () => {}), onRefreshControls: vi.fn(async () => {}) });
const request = { interactionId: 'request', revision: '1', state: 'pending', title: 'Choose destination' } as const;
const question: SessionInteraction = { ...request, kind: 'question', canDismiss: true, questions: [{ questionId: 'destination', label: 'Destination', required: true, multiple: true, allowCustom: true, sensitive: false, options: [{ id: 'eu', label: 'Europe' }] }] };
const form: SessionInteraction = { ...request, kind: 'form', canDismiss: true, fields: [{ fieldId: 'destination', label: 'Destination', type: 'text', required: true, sensitive: false }] };

describe('composer action admission', () => {
  it('preserves the editable draft and open menu while rejecting mouse, Enter and form submissions', () => {
    const props = composerProps();
    const view = render(<SessionComposer {...props} actionAdmitted />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Retain this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    const menu = view.container.querySelector('.session-controls-panel');
    act(() => { input.focus(); input.setSelectionRange(2, 6); });
    view.rerender(<SessionComposer {...props} actionAdmitted={false} />);
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input).not.toHaveAttribute('readonly');
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
    expect(view.container.querySelector('.session-controls-panel')).toBe(menu);
    expect(screen.getByRole('button', { name: 'Model' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.submit(input.closest('form')!);
    fireEvent.change(input, { target: { value: 'Edited during review' } });
    expect(input).toHaveValue('Edited during review');
    expect(props.onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('allows settings browsing while blocking settings and controls refresh callbacks', () => {
    const props = composerProps();
    render(<SessionComposer {...props} actionAdmitted={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    const setting = screen.getByRole('combobox', { name: 'Model' });
    expect(setting).toBeDisabled();
    fireEvent.change(setting, { target: { value: 'b' } });
    const refresh = screen.getByRole('button', { name: 'Refresh controls' });
    expect(refresh).toBeDisabled();
    fireEvent.click(refresh);
    expect(props.onUpdateSetting).not.toHaveBeenCalled();
    expect(props.onRefreshControls).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open chat commands' }));
    const refreshCommands = screen.getByRole('button', { name: 'Refresh commands' });
    expect(refreshCommands).toBeDisabled();
    fireEvent.click(refreshCommands);
    expect(props.onRefreshControls).not.toHaveBeenCalled();
  });

  it('keeps command argument drafting and local menus available without dispatching native commands', () => {
    const props = composerProps();
    render(<SessionComposer {...props} actionAdmitted={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat commands' }));
    const compact = screen.getByRole('option', { name: /\/compact/ });
    expect(compact).toBeDisabled();
    fireEvent.click(compact);
    fireEvent.click(screen.getByRole('option', { name: /\/review/ }));
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('/review ');
    fireEvent.change(input, { target: { value: '/review Drafted instructions' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.submit(input.closest('form')!);
    expect(input).toHaveValue('/review Drafted instructions');
    expect(props.onExecuteCommand).not.toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '/model' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeDisabled();
  });

  it('disables interruption without changing the real working activity', () => {
    const props = composerProps(), s = props.state.snapshot!;
    props.state = { ...props.state, snapshot: { ...s, activity: 'working', currentTurnId: 'turn', operations: { ...s.operations, canCancel: true } } };
    const view = render(<SessionComposer {...props} actionAdmitted />);
    expect(screen.getByRole('button', { name: 'Interrupt' })).toBeEnabled();
    view.rerender(<SessionComposer {...props} actionAdmitted={false} />);
    expect(screen.getByText('Working')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Interrupt' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    expect(props.onCancel).not.toHaveBeenCalled();
  });
});

describe('interaction action admission', () => {
  it.each([question, form])('retains editable $kind answers and only submits after admission returns', async interaction => {
    const onRespond = vi.fn(async () => {});
    const content = (actionAdmitted: boolean, enabled = true) => <SessionInteractionCard interaction={interaction} enabled={enabled} actionAdmitted={actionAdmitted} onRespond={onRespond} />;
    const view = render(content(true));
    const field = screen.getByLabelText(interaction.kind === 'question' ? 'Destination — Other answer' : 'Destination');
    fireEvent.change(field, { target: { value: 'Asia' } });
    view.rerender(content(false));
    expect(field).toBeEnabled();
    expect(field).toHaveValue('Asia');
    fireEvent.change(field, { target: { value: 'New destination' } });
    if (interaction.kind === 'question') { fireEvent.click(screen.getByLabelText('Europe')); expect(screen.getByLabelText('Europe')).toBeChecked(); }
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
    fireEvent.submit(field.closest('form')!);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    view.rerender(content(false, false));
    expect(field).toBeDisabled();
    view.rerender(content(true));
    expect(field).toHaveValue('New destination');
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledOnce());
    expect(onRespond).toHaveBeenCalledWith(interaction.kind === 'question'
      ? { kind: 'question', answers: [{ questionId: 'destination', optionIds: ['eu'], text: 'New destination' }] }
      : { kind: 'form', values: [{ fieldId: 'destination', value: 'New destination' }] });
  });

  it('blocks every declared approval action during review', () => {
    const onRespond = vi.fn(async () => {});
    render(<SessionInteractionCard interaction={{ ...request, kind: 'approval', detail: 'Run command?', actions: ['allow_once', 'reject'] }} enabled actionAdmitted={false} onRespond={onRespond} />);
    for (const label of ['Allow once', 'Reject']) {
      const action = screen.getByRole('button', { name: label });
      expect(action).toBeDisabled(); fireEvent.click(action);
    }
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('keeps pending navigation and expanded content while passing submit admission to live cards', () => {
    const s = snapshot();
    const entries: TimelineEntry[] = [
      { entryId: 'thought', entrySeq: '1', revision: '1', kind: 'reasoning', text: 'Expanded reasoning' },
      { entryId: 'request', entrySeq: '2', revision: '1', kind: 'interaction', interaction: question },
    ];
    const state = hydrateSession(emptySessionState(), { ...s, activity: 'waiting_input', operations: { ...s.operations, canRespond: true } }, entries);
    const onRespond = vi.fn(async () => {});
    const content = (actionAdmitted: boolean, canRespond = true) => <SessionTimeline state={state} active canRespond={canRespond} actionAdmitted={actionAdmitted} onRespond={onRespond} hasOlder={false} loadingOlder={false} onLoadOlder={async () => {}} onLoadResource={async () => new Blob()} />;
    const view = render(content(true));
    const box = view.container.querySelector<HTMLElement>('.session-timeline')!;
    const card = view.container.querySelector<HTMLElement>('.session-interaction')!;
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 320, width: 320, height, x: 0, y: top, toJSON() {} });
    Object.defineProperties(box, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, value: 1000 } });
    vi.spyOn(box, 'getBoundingClientRect').mockImplementation(() => rect(0, 200));
    vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => rect(400 - box.scrollTop, 100));
    vi.spyOn(card.closest('article')!, 'getBoundingClientRect').mockImplementation(() => rect(400 - box.scrollTop, 100));
    act(() => window.dispatchEvent(new Event('resize')));
    const disclosure = screen.getByText('Reasoning').closest('details')!;
    disclosure.open = true; fireEvent(disclosure, new Event('toggle'));
    expect(screen.getByText('Expanded reasoning')).toBeInTheDocument();
    const locator = screen.getByRole('button', { name: 'Pending request · Choose destination' });
    view.rerender(content(false));
    expect(screen.getByRole('button', { name: 'Pending request · Choose destination' })).toBe(locator);
    expect(screen.getByText('Reasoning').closest('details')).toBe(disclosure);
    expect(disclosure).toHaveAttribute('open');
    expect(screen.getByText('Expanded reasoning')).toBeInTheDocument();
    expect(screen.getByLabelText('Destination — Other answer')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
    fireEvent.click(locator);
    expect(screen.getByRole('region', { name: 'Choose destination' })).toHaveFocus();
    expect(onRespond).not.toHaveBeenCalled();
    view.rerender(content(false, false));
    expect(screen.queryByRole('button', { name: /Pending request/ })).toBeNull();
    expect(screen.getByLabelText('Destination — Other answer')).toBeDisabled();
  });
});

it('SessionView closes new actions without disabling the original operation check or local editing', async () => {
  const s = snapshot();
  const operation: SessionOperation = { protocol: s.protocol, ...sessionFence(s), operationId: 'old-operation', kind: 'send_message', state: 'unknown', providerResult: null, error: null };
  let view: SessionViewState & { readonly actionAdmitted: boolean } = {
    actionAdmitted: true, operationProgress: new Map(), settingIntents: new Map(), startupReport: null, errorCode: null, environmentConnected: true,
    historyReady: true, historyRevision: 1, connectionGeneration: 1, archiveState: null, status: 'ready', connected: true, authPaused: false,
    error: null, hasOlder: false, loadingOlder: false, historyError: null, checking: new Set(), draft: { text: 'Retain draft', revision: '1', submission: null },
    state: hydrateSession(emptySessionState(), { ...s, activity: 'waiting_input', operations: { ...s.operations, canRespond: true } }, [{ entryId: 'request', entrySeq: '1', revision: '1', kind: 'interaction', interaction: question }]),
  };
  const listeners = new Set<() => void>();
  const client = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }, snapshot: () => view,
    canInteract: vi.fn(() => true), refresh: vi.fn(), loadOlder: vi.fn(), resource: vi.fn(), respond: vi.fn(), setDraft: vi.fn(), send: vi.fn(), cancel: vi.fn(),
    updateSetting: vi.fn(), executeCommand: vi.fn(), refreshControls: vi.fn(), checkOperation: vi.fn(async () => {}),
  };
  render(<SessionView client={client as unknown as TaskSessionClient} userId="action-admission-user" active current />);
  const input = screen.getByRole('textbox', { name: 'Message' });
  const field = screen.getByLabelText('Destination — Other answer');
  fireEvent.change(field, { target: { value: 'Retained answer' } });
  act(() => { view = { ...view, actionAdmitted: false, state: { ...view.state, operations: new Map([[operation.operationId, operation]]) } }; listeners.forEach(listener => listener()); });
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input);
  expect(input).not.toHaveAttribute('readonly');
  expect(field).toHaveValue('Retained answer');
  expect(field).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Check original operation' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Check original operation' }));
  await waitFor(() => expect(client.checkOperation).toHaveBeenCalledExactlyOnceWith(operation.operationId));
  expect(client.send).not.toHaveBeenCalled();
  expect(client.respond).not.toHaveBeenCalled();
});
