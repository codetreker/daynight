import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot, SessionOperation } from '../src/api/types';
import type { SessionControls } from '../../daynight/src/session/controls';
import { SessionComposer } from '../src/features/task-agent-session/SessionComposer';
import { SessionControlsPanel } from '../src/features/task-agent-session/SessionControlsPanel';
import { hydrateSession, emptySessionState } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';
const render = createLocaleRender('en');
const controls: SessionControls = { revision: '3', settings: [
  { id: 'model', category: 'model', label: 'Model selection', description: null, value: 'native-a', mutable: true, scope: 'session', options: [{ value: 'native-a', label: 'Native A' }, { value: 'native-b', label: 'Native B' }] },
  { id: 'permissions', category: 'permission', label: 'Approval policy', description: 'Native policy', value: 'ask', mutable: true, scope: 'session', options: [{ value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }] },
], commands: [{ id: 'skill:review', name: 'review', description: 'Review changes', argumentHint: 'Review instructions', available: true }, { id: 'compact', name: 'compact', description: 'Compact context', argumentHint: null, available: true }], settingsError: null, commandsError: null };
const snapshot = (): SessionSnapshot => ({ ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), controls, turnStartedAt: null });
const state = () => hydrateSession(emptySessionState(), snapshot(), []);
const base = () => ({ state: state(), connected: true, onSend: vi.fn(async () => {}), onCancel: vi.fn(async () => {}), onExecuteCommand: vi.fn(async () => {}), onUpdateSetting: vi.fn(async () => {}), onRefreshControls: vi.fn(async () => {}) });
describe('composer provider controls', () => {
  it('opens native model and permission settings without changing the draft or submitting input', async () => {
    const props = base(); render(<SessionComposer {...props} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Model selection' }), { target: { value: 'native-b' } });
    await waitFor(() => expect(props.onUpdateSetting).toHaveBeenCalledWith('model', 'native-b', '3'));
    expect(screen.getByRole('textbox')).toHaveValue('draft');
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
    expect(screen.getByRole('combobox', { name: 'Approval policy' })).toHaveValue('ask');
    expect(props.onSend).not.toHaveBeenCalled();
  });
  it('shows target and confirmed native value separately while a setting is pending', () => {
    const s = state(), op = { protocol: s.snapshot!.protocol, sessionId: s.snapshot!.sessionId, claimId: '00000002-1111-4111-8111-111111111111', executionGeneration: '1', operationId: 'pending', kind: 'update_setting', state: 'accepted', providerResult: null, error: null } as SessionOperation;
    const intents = new Map([['model', { operationId: op.operationId, settingId: 'model', value: 'native-b', confirmedValue: 'native-a' }]]);
    render(<SessionControlsPanel controls={controls} state={{ ...s, operations: new Map([[op.operationId, op]]) }} intents={intents} view="model" disabled onClose={() => {}} onSelect={undefined} onRefresh={undefined} />);
    expect(screen.getByRole('combobox')).toHaveValue('native-b');
    expect(screen.getByText('Pending provider confirmation. Current: Native A')).toBeVisible();
  });
  it('filters commands, completes arguments, and invokes the catalog ID instead of sending slash text', async () => {
    const props = base(); render(<SessionComposer {...props} />); const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '/rev' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveValue('/review ');
    fireEvent.change(input, { target: { value: '/review staged changes' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(props.onExecuteCommand).toHaveBeenCalledWith('skill:review', 'staged changes', '3', '/review staged changes'));
    expect(props.onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(input).toHaveValue(''));
  });
  it('opens local slash settings and rejects unknown slash commands', async () => {
    const props = base(); render(<SessionComposer {...props} />);const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '/model' } });fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('combobox', { name: 'Model selection' })).toBeVisible();
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.change(input, { target: { value: '/made-up' } });fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText(/Unknown or unavailable command/)).toBeVisible();
    expect(props.onExecuteCommand).not.toHaveBeenCalled();expect(props.onSend).not.toHaveBeenCalled();expect(input).toHaveValue('/made-up');
  });
  it('uses arrow navigation, exposes directory errors and retries discovery without agent input', async () => {
    const props = base(); props.state = { ...props.state, snapshot: { ...props.state.snapshot!, controls: { ...controls, commandsError: 'Native discovery failed' } } };
    render(<SessionComposer {...props} />);const input = screen.getByRole('textbox');fireEvent.change(input, { target: { value: '/' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });expect(screen.getByRole('option', { name: /\/permissions/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Native discovery failed')).toBeVisible();fireEvent.click(screen.getByRole('button', { name: 'Retry commands' }));
    await waitFor(() => expect(props.onRefreshControls).toHaveBeenCalledOnce());expect(props.onSend).not.toHaveBeenCalled();
  });
  it('retains controls and draft while identity is paused, but cannot mutate', () => {
    const props = base();render(<SessionComposer {...props} authPaused />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/compact' } });fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));expect(screen.getByRole('combobox')).toBeDisabled();
    expect(props.onExecuteCommand).not.toHaveBeenCalled();expect(props.onSend).not.toHaveBeenCalled();expect(screen.queryByText('Restoring session')).toBeNull();
  });
  it('shows native working time, keeps steer available, and waits on interrupt independently', async () => {
    const props = base();props.state = { ...props.state, snapshot: { ...props.state.snapshot!, activity: 'working', currentTurnId: 'turn', turnStartedAt: new Date(Date.now() - 45000).toISOString(), operations: { canSend: true, canCancel: true, canRespond: true } } };
    let resolve!: () => void;props.onCancel.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    render(<SessionComposer {...props} />);fireEvent.change(screen.getByRole('textbox'), { target: { value: 'steer now' } });
    expect(screen.getByRole('button', { name: 'Add to current turn' })).toBeEnabled();
    const activity = screen.getByLabelText('Agent activity');expect(within(activity).getByText('Working')).toBeVisible();expect(within(activity).getByLabelText('Turn elapsed time').textContent).toMatch(/^4[5-9]s$/);
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));expect(await screen.findByRole('button', { name: 'Interrupting…' })).toBeDisabled();
    expect(props.onCancel).toHaveBeenCalledOnce();await act(async () => resolve());expect(screen.getByRole('textbox')).toHaveValue('steer now');
    expect(screen.getByRole('button', { name: 'Interrupt requested' })).toBeDisabled();
  });
});

it('preserves unrelated draft text when a toolbar command executes', async () => {
  const props = base();render(<SessionComposer {...props} />);const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'still writing this' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open chat commands' }));
  fireEvent.click(screen.getByRole('option', { name: /\/compact/ }));
  await waitFor(() => expect(props.onExecuteCommand).toHaveBeenCalledWith('compact', '', '3', undefined));
  expect(input).toHaveValue('still writing this');
});
