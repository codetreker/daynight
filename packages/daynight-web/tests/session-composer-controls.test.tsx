import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('command candidate reverse navigation', () => {
  it.each(['/model', '/permissions', '/compact', '/rev'])('preserves plain Tab confirmation for %s', async value => {
    const props = base(); render(<SessionComposer {...props} />);
    const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value } });
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(false);
    if (value === '/model') expect(screen.getByRole('combobox', { name: 'Model' })).toBeVisible();
    else if (value === '/permissions') expect(screen.getByRole('combobox', { name: 'Approval policy' })).toBeVisible();
    else if (value === '/rev') expect(input).toHaveValue('/review ');
    else await waitFor(() => expect(props.onExecuteCommand).toHaveBeenCalledExactlyOnceWith('compact', '', '3', '/compact'));
    if (value !== '/compact') expect(props.onExecuteCommand).not.toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled(); expect(props.onUpdateSetting).not.toHaveBeenCalled();
  });

  it('preserves an externally owned draft and reverse navigation with the menu already closed', async () => {
    const user = userEvent.setup(), props = base(), onDraftChange = vi.fn();
    render(<><button>Previous control</button><SessionComposer {...props} draft={{ text: '/model', revision: 'draft-1', submission: null }} onDraftChange={onDraftChange} /></>);
    const input = screen.getByRole('textbox');
    for (let index = 0; index < 2; index++) {
      act(() => input.focus()); await user.tab({ shift: true });
      expect(screen.getByRole('button', { name: 'Previous control' })).toHaveFocus();
      expect(input).toHaveValue('/model'); expect(screen.queryByRole('listbox')).toBeNull();
    }
    expect(onDraftChange).not.toHaveBeenCalled(); expect(props.onSend).not.toHaveBeenCalled(); expect(props.onExecuteCommand).not.toHaveBeenCalled();
  });

  it.each(['/model', '/permissions', '/compact', '/rev', '/missing', '/'])('leaves %s unchanged and skips the dismissed menu', async value => {
    const user = userEvent.setup(), props = base();
    render(<><button>Previous control</button><SessionComposer {...props} /></>);
    const input = screen.getByRole('textbox');
    for (const explicit of [false, true]) {
      fireEvent.change(input, { target: { value } });
      if (explicit) fireEvent.keyDown(input, { key: 'ArrowDown' });
      act(() => input.focus());
      await user.tab({ shift: true });
      expect(screen.getByRole('button', { name: 'Previous control' })).toHaveFocus();
      expect(input).toHaveValue(value);
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(screen.queryByRole('combobox')).toBeNull();
      // Reopen even when the next iteration uses the same draft.
      if (!explicit) fireEvent.click(screen.getByRole('button', { name: 'Open chat commands' }));
    }
    expect(props.onSend).not.toHaveBeenCalled();
    expect(props.onExecuteCommand).not.toHaveBeenCalled();
    expect(props.onUpdateSetting).not.toHaveBeenCalled();
  });

  it.each(['offline', 'auth', 'unavailable', 'pending', 'empty-catalog'] as const)('retains reverse navigation while %s', async mode => {
    const user = userEvent.setup(), props = base();
    if (mode === 'unavailable') props.state = { ...props.state, snapshot: { ...props.state.snapshot!, controls: { ...controls, commands: controls.commands.map(command => ({ ...command, available: false })) } } };
    if (mode === 'empty-catalog') { const { controls: omitted, ...withoutControls } = props.state.snapshot!; props.state = { ...props.state, snapshot: withoutControls }; }
    let finish!: () => void;
    if (mode === 'pending') props.onExecuteCommand.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<><button>Previous control</button><SessionComposer {...props} connected={mode !== 'offline'} authPaused={mode === 'auth'} /></>);
    const input = screen.getByRole('textbox');
    if (mode === 'pending') {
      fireEvent.change(input, { target: { value: '/compact' } });
      fireEvent.keyDown(input, { key: 'Tab' });
      expect(props.onExecuteCommand).toHaveBeenCalledOnce();
      props.onExecuteCommand.mockClear();
    }
    const value = mode === 'offline' ? '/' : '/rev';
    fireEvent.change(input, { target: { value } });
    act(() => input.focus());
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Previous control' })).toHaveFocus();
    expect(input).toHaveValue(value);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(props.onSend).not.toHaveBeenCalled(); expect(props.onExecuteCommand).not.toHaveBeenCalled();
    if (mode === 'pending') await act(async () => finish());
  });

  it('removes menu controls before outer native Tab handlers inspect the focus order', () => {
    render(<SessionComposer {...base()} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '/model' } });
    const observed: boolean[] = [];
    const outer = (event: KeyboardEvent) => { if (event.key === 'Tab') observed.push(event.defaultPrevented || document.querySelector('.session-command-menu') !== null); };
    document.addEventListener('keydown', outer);
    try { expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })).toBe(true); }
    finally { document.removeEventListener('keydown', outer); }
    expect(observed).toEqual([false]);
  });

  it.each(['native', '229', 'composition'] as const)('leaves %s IME Shift+Tab untouched', mode => {
    const props = base(); render(<SessionComposer {...props} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '/model' } });
    if (mode === 'composition') fireEvent.compositionStart(input);
    expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey: true, isComposing: mode === 'native', keyCode: mode === '229' ? 229 : 9 })).toBe(true);
    expect(screen.getByRole('listbox')).toBeInTheDocument(); expect(input).toHaveValue('/model');
    expect(props.onSend).not.toHaveBeenCalled(); expect(props.onExecuteCommand).not.toHaveBeenCalled();
  });
});
describe('composer provider controls', () => {
  it('opens native model and permission settings without changing the draft or submitting input', async () => {
    const props = base(); render(<SessionComposer {...props} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'native-b' } });
    await waitFor(() => expect(props.onUpdateSetting).toHaveBeenCalledWith('model', 'native-b', '3'));
    expect(screen.getByRole('textbox')).toHaveValue('draft');
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
    expect(screen.getByRole('combobox', { name: 'Approval policy' })).toHaveValue('ask');
    expect(props.onSend).not.toHaveBeenCalled();
  });
  it('shows target and confirmed native value separately while a setting is pending', () => {
    const s = state(), op = { protocol: s.snapshot!.protocol, sessionId: s.snapshot!.sessionId, claimId: '00000002-1111-4111-8111-111111111111', executionGeneration: '1', operationId: 'pending', kind: 'update_setting', state: 'accepted', providerResult: null, error: null } as SessionOperation;
    const intents = new Map([['model', { operationId: op.operationId, settingId: 'model', value: 'native-b', confirmedValue: 'native-a' }]]);
    render(<SessionControlsPanel controls={controls} state={{ ...s, operations: new Map([[op.operationId, op]]) }} intents={intents} operationProgress={new Map([[op.operationId, 'sending']])} view="model" disabled onClose={() => {}} onSelect={undefined} onRefresh={undefined} />);
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
  it('opens local slash settings and sends unknown slash input normally', async () => {
    const props = base(); render(<SessionComposer {...props} />);const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '/model' } });fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeVisible();
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.change(input, { target: { value: '/made-up' } });fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('/made-up'));
    expect(props.onExecuteCommand).not.toHaveBeenCalled(); expect(screen.queryByText(/Unknown or unavailable command/)).toBeNull();
  });
  it('uses arrow navigation, exposes directory errors and retries discovery without agent input', async () => {
    const props = base(); props.state = { ...props.state, snapshot: { ...props.state.snapshot!, controls: { ...controls, commandsError: 'Native discovery failed' } } };
    render(<SessionComposer {...props} />);const input = screen.getByRole('textbox');fireEvent.change(input, { target: { value: '/' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });expect(screen.getByRole('option', { name: /\/permissions/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Native discovery failed')).toBeVisible();fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
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

it('keeps input, controls, activity, actions, and keyboard help inside one chatbox in focus order', () => {
  const props = base();
  props.state = { ...props.state, snapshot: { ...props.state.snapshot!, activity: 'working', currentTurnId: 'turn', turnStartedAt: new Date().toISOString(), operations: { canSend: true, canCancel: true, canRespond: true } } };
  const view = render(<SessionComposer {...props} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Keep this draft' } });
  const surface = input.closest('.session-composer-surface');
  expect(surface).not.toBeNull();
  expect(surface).toContainElement(screen.getByLabelText('Agent activity'));
  expect(surface).toContainElement(screen.getByText(/Enter to send/));
  const buttons = within(surface as HTMLElement).getAllByRole('button');
  expect(buttons.map(button => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Model', 'Permissions', 'Open chat commands', 'Interrupt', 'Add to current turn']);
  expect(buttons[4]).toHaveAccessibleDescription('Enter to send · Shift+Enter for a new line · /');
  expect(buttons[4]!.parentElement).toContainElement(screen.getByText(/Enter to send/));
  fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
  expect(surface).not.toContainElement(screen.getByLabelText('Permission settings'));
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
  expect(input).toHaveFocus();
  expect(input).toHaveValue('Keep this draft');
  view.setLocale('zh-CN');
  expect(screen.getByRole('textbox')).toBe(input);
  expect(within(surface as HTMLElement).getByRole('button', { name: 'Permissions' })).toBe(buttons[1]);
  expect(props.onSend).not.toHaveBeenCalled();
});

it('groups interruption with submission while preserving the custom footer activity contract', () => {
  const props = base();
  props.state = { ...props.state, snapshot: { ...props.state.snapshot!, activity: 'working', currentTurnId: 'turn', turnStartedAt: new Date().toISOString(), operations: { canSend: true, canCancel: true, canRespond: true } } };
  const view = render(<SessionComposer {...props} />);
  const interrupt = screen.getByRole('button', { name: 'Interrupt' });
  const actions = interrupt.closest('.session-primary-actions');
  expect(actions).not.toBeNull();
  expect(actions).toContainElement(screen.getByRole('button', { name: 'Add to current turn' }));
  expect(screen.getByLabelText('Agent activity')).not.toContainElement(interrupt);
  fireEvent.mouseEnter(interrupt);
  expect(screen.getByRole('button', { name: 'Add to current turn' }).parentElement).not.toHaveAttribute('data-hint-open');
  view.rerender(<SessionComposer {...props} presentation={{ renderFooter: ({ settings, activity, submit }) => <>{settings}<section aria-label="Custom activity">{activity}</section>{submit}</> }} />);
  expect(screen.getByLabelText('Custom activity')).toContainElement(screen.getByRole('button', { name: 'Interrupt' }));
  expect(screen.getByLabelText('Custom activity')).toHaveTextContent('Working');
  expect(screen.getAllByRole('button', { name: 'Interrupt' })).toHaveLength(1);
});

it('keeps failed submission details with the draft inside the same chatbox', async () => {
  const props = base(); props.onSend.mockRejectedValue(new Error('Native delivery failed'));
  render(<SessionComposer {...props} />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Retain this input' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const error = await screen.findByRole('alert');
  expect(error).toHaveTextContent('Native delivery failed');
  expect(input.closest('.session-composer-surface')).toContainElement(error);
  expect(input).toHaveValue('Retain this input');
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
});

it.each(['focus', 'hover'] as const)('consumes Escape for a %s keyboard hint before the outer surface can close', mode => {
  const props = base(); render(<SessionComposer {...props} />);
  const input = screen.getByRole('textbox'), submit = screen.getByRole('button', { name: 'Send' });
  fireEvent.change(input, { target: { value: 'Preserve this draft' } });
  act(() => { (mode === 'focus' ? submit : input).focus(); });
  if (mode === 'hover') fireEvent.mouseEnter(submit.parentElement!);
  const outerEscape = vi.fn();
  document.addEventListener('keydown', outerEscape);
  try {
    const target = mode === 'focus' ? submit : input;
    expect(fireEvent.keyDown(target, { key: 'Escape', cancelable: true })).toBe(false);
    expect(outerEscape).not.toHaveBeenCalled();
    expect(target).toHaveFocus();
    expect(input).toHaveValue('Preserve this draft');
    // Once the hint is dismissed, Escape retains the surrounding surface's behavior.
    expect(fireEvent.keyDown(target, { key: 'Escape', cancelable: true })).toBe(true);
    expect(outerEscape).toHaveBeenCalledOnce();
    expect(props.onSend).not.toHaveBeenCalled(); expect(props.onCancel).not.toHaveBeenCalled();
  } finally { document.removeEventListener('keydown', outerEscape); }
});

it('dismisses a hovered hint before closing an open controls panel, then allows the outer Escape', () => {
  render(<SessionComposer {...base()} />);
  const input = screen.getByRole('textbox'), submit = screen.getByRole('button', { name: 'Send' });
  fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
  act(() => input.focus());
  fireEvent.mouseEnter(submit.parentElement!);
  const outerEscape = vi.fn(); document.addEventListener('keydown', outerEscape);
  try {
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByLabelText('Permission settings')).toBeVisible();
    expect(outerEscape).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('Permission settings')).toBeNull();
    expect(outerEscape).not.toHaveBeenCalled(); expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(outerEscape).toHaveBeenCalledOnce();
  } finally { document.removeEventListener('keydown', outerEscape); }
});

it('dismisses a hovered keyboard hint when focus is outside the chatbox, then restores outer Escape', () => {
  render(<><button type="button">Refresh session</button><SessionComposer {...base()} /></>);
  const outside = screen.getByRole('button', { name: 'Refresh session' });
  act(() => outside.focus());
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'Send' }).parentElement!);
  const outerEscape = vi.fn(); document.addEventListener('keydown', outerEscape);
  try {
    expect(fireEvent.keyDown(outside, { key: 'Escape', cancelable: true })).toBe(false);
    expect(outerEscape).not.toHaveBeenCalled(); expect(outside).toHaveFocus();
    expect(fireEvent.keyDown(outside, { key: 'Escape', cancelable: true })).toBe(true);
    expect(outerEscape).toHaveBeenCalledOnce();
  } finally { document.removeEventListener('keydown', outerEscape); }
});

it('releases visible hint Escape ownership when the composer becomes inactive or unmounts', () => {
  const props = base();
  const view = render(<><button type="button">Outside</button><SessionComposer {...props} /></>);
  const outside = screen.getByRole('button', { name: 'Outside' }); act(() => outside.focus());
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'Send' }).parentElement!);
  const outerEscape = vi.fn(); document.addEventListener('keydown', outerEscape);
  try {
    view.rerender(<><button type="button">Outside</button><SessionComposer {...props} active={false} /></>);
    expect(fireEvent.keyDown(outside, { key: 'Escape', cancelable: true })).toBe(true);
    expect(outerEscape).toHaveBeenCalledOnce();
    view.rerender(<><button type="button">Outside</button><SessionComposer {...props} /></>);
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Send' }).parentElement!);
    view.rerender(<button type="button">Outside</button>);
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'Outside' }), { key: 'Escape', cancelable: true })).toBe(true);
    expect(outerEscape).toHaveBeenCalledTimes(2);
  } finally { document.removeEventListener('keydown', outerEscape); }
});

it('leaves IME Escape native while a hovered hint is visible', () => {
  render(<><input aria-label="Outside input" /><SessionComposer {...base()} /></>);
  const outside = screen.getByRole('textbox', { name: 'Outside input' }); act(() => outside.focus());
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'Send' }).parentElement!);
  const outerKey = vi.fn(); document.addEventListener('keydown', outerKey);
  try {
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) expect(fireEvent.keyDown(outside, { key: 'Escape', cancelable: true, ...composition })).toBe(true);
    expect(outerKey).toHaveBeenCalledTimes(2);
    // Native composition handling did not dismiss the hint or consume the next ordinary Escape.
    expect(fireEvent.keyDown(outside, { key: 'Escape', cancelable: true })).toBe(false);
    expect(outerKey).toHaveBeenCalledTimes(2); expect(outside).toHaveFocus();
  } finally { document.removeEventListener('keydown', outerKey); }
});

it.each(['ready', 'unavailable', 'failed', 'empty', 'disabled', 'refreshing'] as const)('closes the %s command catalog without changing the draft or invoking a provider operation', async mode => {
  const props = base();
  if (mode === 'unavailable') {
    const { controls: _controls, ...withoutControls } = props.state.snapshot!;
    props.state = { ...props.state, snapshot: withoutControls };
  }
  if (mode === 'failed') props.state = { ...props.state, snapshot: { ...props.state.snapshot!, controls: { ...controls, commandsError: 'Discovery failed' } } };
  let finish!: () => void;
  if (mode === 'refreshing') props.onRefreshControls.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<SessionComposer {...props} authPaused={mode === 'disabled'} />);
  const input = screen.getByRole('textbox');
  const draft = mode === 'empty' ? '/not-a-command' : 'Keep\nthis draft';
  fireEvent.change(input, { target: { value: draft } });
  if (mode !== 'empty') fireEvent.click(screen.getByRole('button', { name: 'Open chat commands' }));
  if (mode === 'refreshing') fireEvent.click(screen.getByRole('button', { name: 'Refresh commands' }));
  const close = screen.getByRole('button', { name: 'Close' });
  expect(close).toBeEnabled();
  fireEvent.click(close);
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.queryByText('Native commands')).toBeNull();
  expect(input).toHaveValue(draft); expect(input).toHaveFocus();
  expect(props.onSend).not.toHaveBeenCalled(); expect(props.onExecuteCommand).not.toHaveBeenCalled(); expect(props.onUpdateSetting).not.toHaveBeenCalled();
  if (mode === 'refreshing') await act(async () => finish());
});

it.each(['retry', 'option', 'close'] as const)('dismisses the command menu from %s before an outer Escape handler', target => {
  const props = base(), outer = vi.fn();
  render(<div onKeyDown={outer}><SessionComposer {...props} /></div>);
  const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: '/compact' } });
  const element = target === 'option' ? screen.getByRole('option') : screen.getByRole('button', { name: target === 'close' ? 'Close' : 'Refresh commands' });
  element.focus(); fireEvent.keyDown(element, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull(); expect(outer).not.toHaveBeenCalled();
  expect(input).toHaveFocus(); expect(input).toHaveValue('/compact');
  expect(props.onExecuteCommand).not.toHaveBeenCalled(); expect(props.onSend).not.toHaveBeenCalled();
});

it('keeps command discovery open through IME Escape and closes on the next ordinary Escape', () => {
  render(<SessionComposer {...base()} />);
  const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: '/' } });
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    fireEvent.keyDown(input, { key: 'Escape', ...composition }); expect(screen.getByRole('listbox')).toBeInTheDocument();
  }
  fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Escape' }); expect(screen.getByRole('listbox')).toBeInTheDocument();
  fireEvent.compositionEnd(input); fireEvent.keyDown(input, { key: 'Escape' }); expect(screen.queryByRole('listbox')).toBeNull();
});

it('dismisses commands on an outside pointer without stealing focus or consuming the target action', () => {
  const action = vi.fn(); render(<><button onClick={action}>Outside action</button><SessionComposer {...base()} /></>);
  const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: 'Draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open chat commands' }));
  const outside = screen.getByRole('button', { name: 'Outside action' });
  outside.focus(); fireEvent.pointerDown(outside); fireEvent.click(outside);
  expect(screen.queryByRole('listbox')).toBeNull(); expect(outside).toHaveFocus(); expect(action).toHaveBeenCalledOnce(); expect(input).toHaveValue('Draft');
});

it('reveals keyboard selection at both ends of a long catalog without accumulating fractional layout error', () => {
  render(<SessionComposer {...base()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open chat commands' }));
  const body = screen.getByRole('listbox').parentElement!;
  Object.defineProperties(body, { clientHeight: { value: 181 }, offsetHeight: { value: 181 } });
  vi.spyOn(body, 'getBoundingClientRect').mockImplementation(() => ({ top: 100, bottom: 281.40625, height: 181.40625, width: 400, x: 0, y: 100, left: 0, right: 400, toJSON() {} }));
  screen.getAllByRole('option').forEach((option, index) => {
    Object.defineProperties(option, { offsetTop: { value: index * 500 }, offsetHeight: { value: 200 } });
    vi.spyOn(option, 'getBoundingClientRect').mockImplementation(() => ({ top: 100 + index * 500 - body.scrollTop, bottom: 300 + index * 500 - body.scrollTop, height: 200, width: 400, x: 0, y: 100 + index * 500 - body.scrollTop, left: 0, right: 400, toJSON() {} }));
  });
  const input = screen.getByRole('textbox');
  fireEvent.keyDown(input, { key: 'ArrowUp' });
  expect(body.scrollTop).toBe(1500);
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(body.scrollTop).toBe(0);
  expect(input).toHaveFocus();
});


it.each(['/Users/name/copilot 路径说明', '/made-up', '/mo', '/', '  /Users/a/copilot  中文\n保留  空格\n第二行  '])('sends unmatched input %j through Enter and the button with only outer whitespace trimmed', async value => {
  const props = base(); render(<SessionComposer {...props} />); const input = screen.getByRole('textbox');
  for (const submit of ['enter', 'button']) {
    fireEvent.change(input, { target: { value } });
    if (submit === 'enter') fireEvent.keyDown(input, { key: 'Enter' });
    else fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(input).toHaveValue(''));
  }
  expect(props.onSend.mock.calls).toEqual([[value.trim()], [value.trim()]]);
  expect(props.onExecuteCommand).not.toHaveBeenCalled(); expect(screen.queryByRole('combobox')).toBeNull();
});

it.each(['removed', 'replaced', 'unavailable', 'ambiguous'] as const)('retains selected command intent when its catalog is %s', async mode => {
  const props = base(); const view = render(<SessionComposer {...props} />); const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '/rev' } }); fireEvent.keyDown(input, { key: 'Tab' });
  fireEvent.change(input, { target: { value: '/review changed arguments' } }); fireEvent.keyDown(input, { key: 'Escape' });
  const original = controls.commands[0]!;
  const commands = mode === 'removed' ? [] : mode === 'replaced' ? [{ ...original, id: 'replacement' }] : mode === 'unavailable' ? [{ ...original, available: false }] : [original, { ...original, id: 'second' }];
  view.rerender(<SessionComposer {...props} state={{ ...props.state, snapshot: { ...props.state.snapshot!, controls: { ...controls, revision: '4', commands } } }} />);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(await screen.findByText(/Unknown or unavailable command/)).toBeVisible();
  expect(props.onExecuteCommand).not.toHaveBeenCalled(); expect(props.onSend).not.toHaveBeenCalled(); expect(input).toHaveValue('/review changed arguments');
  fireEvent.change(input, { target: { value: '/different changed arguments' } }); fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('/different changed arguments'));
});

it('uses the current revision for a selected command and preserves a newer draft during acceptance', async () => {
  const props = base(); let resolve!: () => void;
  props.onExecuteCommand.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  const view = render(<SessionComposer {...props} />); const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '/rev' } }); fireEvent.keyDown(input, { key: 'Tab' });
  fireEvent.change(input, { target: { value: '/review new arguments' } });
  view.rerender(<SessionComposer {...props} state={{ ...props.state, snapshot: { ...props.state.snapshot!, controls: { ...controls, revision: '4' } } }} />);
  fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter' });
  expect(props.onExecuteCommand).toHaveBeenCalledExactlyOnceWith('skill:review', 'new arguments', '4', '/review new arguments');
  fireEvent.change(input, { target: { value: 'new draft' } }); await act(async () => resolve());
  expect(input).toHaveValue('new draft'); expect(props.onSend).not.toHaveBeenCalled();
});

it('requires an explicit arrow selection before Enter completes a prefix and resets it on edits and catalog refresh', async () => {
  const props = base(); const view = render(<SessionComposer {...props} />); const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '/mo' } }); fireEvent.keyDown(input, { key: 'ArrowDown' }); fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByRole('combobox', { name: 'Model' })).toBeVisible(); fireEvent.keyDown(input, { key: 'Escape' });
  fireEvent.change(input, { target: { value: '/m' } }); fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.change(input, { target: { value: '/mo' } }); fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('/mo'));
  fireEvent.change(input, { target: { value: '/mo' } }); fireEvent.keyDown(input, { key: 'ArrowDown' });
  view.rerender(<SessionComposer {...props} state={{ ...props.state, snapshot: { ...props.state.snapshot!, controls: { ...controls, revision: '4' } } }} />);
  fireEvent.keyDown(input, { key: 'Enter' }); await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(2));
});

it.each(['missing', 'failed', 'working'] as const)('uses the ordinary send gate for unmatched slash input with %s controls', async mode => {
  const props = base(); const { controls: _controls, ...withoutControls } = props.state.snapshot!;
  props.state = { ...props.state, snapshot: mode === 'missing' ? withoutControls : { ...props.state.snapshot!, ...(mode === 'working' ? { activity: 'working', currentTurnId: 'turn' } : {}), controls: { ...controls, commandsError: 'Discovery failed' } } };
  render(<SessionComposer {...props} />); const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '/Users/path 中文' } });
  const submit = screen.getByRole('button', { name: mode === 'working' ? 'Add to current turn' : 'Send' });
  expect(submit).toBeEnabled(); fireEvent.click(submit);
  await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('/Users/path 中文')); expect(props.onExecuteCommand).not.toHaveBeenCalled();
});

it.each(['Provider rejected', 'Delivery outcome is unknown'])('never downgrades a command after %s', async failure => {
  const props = base(); props.onExecuteCommand.mockRejectedValue(new Error(failure)); render(<SessionComposer {...props} />);
  const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: '/compact' } }); fireEvent.keyDown(input, { key: 'Enter' });
  expect(await screen.findByRole('alert')).toHaveTextContent(failure); expect(input).toHaveValue('/compact');
  expect(props.onExecuteCommand).toHaveBeenCalledOnce(); expect(props.onSend).not.toHaveBeenCalled();
});

it.each(['escape', 'toolbar', 'inactive'] as const)('clears temporary arrow selection across %s menu lifecycle', async mode => {
  const props = base(); const view = render(<SessionComposer {...props} />); const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '/mo' } }); fireEvent.keyDown(input, { key: 'ArrowDown' });
  if (mode === 'escape') fireEvent.keyDown(input, { key: 'Escape' });
  else if (mode === 'toolbar') fireEvent.click(screen.getByRole('button', { name: 'Open chat commands' }));
  else { view.rerender(<SessionComposer {...props} active={false} />); view.rerender(<SessionComposer {...props} />); }
  if (mode !== 'inactive') fireEvent.click(screen.getByRole('button', { name: 'Open chat commands' }));
  fireEvent.keyDown(input, { key: 'Enter' }); await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('/mo'));
  expect(screen.queryByRole('combobox')).toBeNull();
});

it('clears selected command intent on a session change even when the draft header stays the same', async () => {
  const props = base(); const view = render(<SessionComposer {...props} />); const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '/rev' } }); fireEvent.keyDown(input, { key: 'Tab' });
  fireEvent.change(input, { target: { value: '/review text' } });
  view.rerender(<SessionComposer {...props} state={{ ...props.state, snapshot: { ...props.state.snapshot!, sessionId: 'other-session', controls: { ...controls, commands: [] } } }} />);
  fireEvent.keyDown(input, { key: 'Enter' }); await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('/review text'));
  expect(props.onExecuteCommand).not.toHaveBeenCalled();
});

it('rejects direct ambiguous and unavailable commands while preserving their text', async () => {
  const props = base(), original = controls.commands[0]!;
  props.state = { ...props.state, snapshot: { ...props.state.snapshot!, controls: { ...controls, commands: [original, { ...original, id: 'duplicate' }, { ...controls.commands[1]!, available: false }] } } };
  render(<SessionComposer {...props} />); const input = screen.getByRole('textbox');
  for (const value of ['/review args', '/compact', '/model invalid']) {
    fireEvent.change(input, { target: { value } }); fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText(/Unknown or unavailable command/)).toBeVisible(); expect(input).toHaveValue(value);
  }
  expect(props.onSend).not.toHaveBeenCalled(); expect(props.onExecuteCommand).not.toHaveBeenCalled();
});

it('preserves unknown text and prevents duplicate ordinary sends while a result is pending or unknown', async () => {
  const props = base(); let reject!: (reason: Error) => void;
  props.onSend.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  render(<SessionComposer {...props} />); const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '/Users/path  中文' } });
  fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter' });
  expect(props.onSend).toHaveBeenCalledOnce();
  await act(async () => reject(new Error('Delivery outcome is unknown')));
  expect(await screen.findByRole('alert')).toHaveTextContent('Delivery outcome is unknown'); expect(input).toHaveValue('/Users/path  中文');
  expect(props.onExecuteCommand).not.toHaveBeenCalled();
});

it('leaves slash text untouched for IME and Shift+Enter', () => {
  const props = base(); render(<SessionComposer {...props} />); const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '/mo' } });
  expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true);
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) expect(fireEvent.keyDown(input, { key: 'Enter', ...composition })).toBe(true);
  fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.compositionEnd(input);
  expect(input).toHaveValue('/mo'); expect(props.onSend).not.toHaveBeenCalled(); expect(props.onExecuteCommand).not.toHaveBeenCalled();
});

it.each(['offline', 'auth', 'read-only', 'unsynchronized', 'pending', 'no-steer'] as const)('does not bypass the %s send restriction for slash text', mode => {
  const props = base();
  if (mode === 'read-only') props.state = { ...props.state, snapshot: { ...props.state.snapshot!, operations: { ...props.state.snapshot!.operations, canSend: false } } };
  if (mode === 'unsynchronized') props.state = { ...props.state, snapshot: { ...props.state.snapshot!, synchronized: false } };
  if (mode === 'no-steer') props.state = { ...props.state, snapshot: { ...props.state.snapshot!, activity: 'working', currentTurnId: 'turn', capabilities: { ...props.state.snapshot!.capabilities, steer: false } } };
  if (mode === 'pending') props.state = { ...props.state, operations: new Map([['pending', { protocol: props.state.snapshot!.protocol, sessionId: props.state.snapshot!.sessionId, claimId: props.state.snapshot!.claimId, executionGeneration: props.state.snapshot!.executionGeneration, operationId: 'pending', kind: 'send_message', state: 'unknown', providerResult: null, error: null } as SessionOperation]]) };
  render(<SessionComposer {...props} connected={mode !== 'offline'} authPaused={mode === 'auth'} />);
  const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: '/Users/path 中文' } });
  expect(screen.getByRole('button', { name: mode === 'no-steer' ? 'Add to current turn' : 'Send' })).toBeDisabled();
  fireEvent.keyDown(input, { key: 'Enter' }); expect(props.onSend).not.toHaveBeenCalled(); expect(props.onExecuteCommand).not.toHaveBeenCalled();
});

it.each(['equivalent', 'activity', 'settings'] as const)('preserves explicit command navigation through a %s snapshot with the same catalog', async mode => {
  const props = base(); const view = render(<SessionComposer {...props} />); const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '/mo' } }); fireEvent.keyDown(input, { key: 'ArrowDown' });
  // Snapshot transport reconstructs controls even when the native catalog is unchanged.
  const next = JSON.parse(JSON.stringify(props.state.snapshot)) as SessionSnapshot;
  const nextSnapshot: SessionSnapshot = mode === 'activity' ? { ...next, sessionRevision: '13', activity: 'working', currentTurnId: 'turn' } : mode === 'settings' ? { ...next, controls: { ...next.controls!, settings: next.controls!.settings.map(setting => ({ ...setting, value: 'native-b' })) } } : next;
  view.rerender(<SessionComposer {...props} state={hydrateSession(props.state, nextSnapshot, [])} />);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByRole('combobox', { name: 'Model' })).toBeVisible();
  expect(props.onSend).not.toHaveBeenCalled(); expect(props.onExecuteCommand).not.toHaveBeenCalled();
});

it.each(['revision', 'description', 'availability', 'id', 'error'] as const)('resets explicit command navigation when catalog %s changes', async mode => {
  const props = base(); const view = render(<SessionComposer {...props} />); const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '/rev' } }); fireEvent.keyDown(input, { key: 'ArrowDown' });
  const commands = controls.commands.map((command, index) => index !== 0 ? command : { ...command, ...(mode === 'description' ? { description: 'Changed description' } : mode === 'availability' ? { available: false } : mode === 'id' ? { id: 'new-review' } : {}) });
  const nextSnapshot: SessionSnapshot = { ...props.state.snapshot!, controls: { ...controls, commands, ...(mode === 'revision' ? { revision: '4' } : mode === 'error' ? { commandsError: 'Discovery failed' } : {}) } };
  view.rerender(<SessionComposer {...props} state={hydrateSession(props.state, nextSnapshot, [])} />);
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('/rev'));
  expect(props.onExecuteCommand).not.toHaveBeenCalled();
});


it.each([
  ['unknown', 'sending', 'Pending provider confirmation. Current: Native A'],
  ['dispatching', 'waiting', 'Still awaiting acceptance… Current: Native A'],
  ['accepted', undefined, 'Change outcome is unknown. Check the original operation. Current: Native A'],
  ['unknown', undefined, 'Change outcome is unknown. Check the original operation. Current: Native A'],
] as const)('distinguishes setting %s with %s page progress from an uncertain restored change', (phase, progress, label) => {
  const s = state();
  const operation: SessionOperation = { protocol: s.snapshot!.protocol, sessionId: s.snapshot!.sessionId, claimId: '00000002-1111-4111-8111-111111111111', executionGeneration: '1', operationId: 'setting', kind: 'update_setting', state: phase, providerResult: null, error: null };
  const intents = new Map([['model', { operationId: operation.operationId, settingId: 'model', value: 'native-b', confirmedValue: 'native-a' }]]);
  render(<SessionControlsPanel controls={controls} state={{ ...s, operations: new Map([[operation.operationId, operation]]) }} intents={intents} operationProgress={progress ? new Map([[operation.operationId, progress]]) : new Map()} view="model" disabled onClose={() => {}} onSelect={undefined} onRefresh={undefined} />);
  expect(screen.getByRole('combobox')).toBeDisabled();
  expect(screen.getByRole('combobox')).toHaveValue('native-b');
  expect(screen.getByText(label)).toBeVisible();
});

it.each(['send_message', 'execute_command', 'update_setting', 'refresh_controls'] as const)('keeps %s pending without a warning or a fallback read-only notice', kind => {
  const props = base(), s = props.state.snapshot!;
  const operation: SessionOperation = { protocol: s.protocol, sessionId: s.sessionId, claimId: '00000002-1111-4111-8111-111111111111', executionGeneration: '1', operationId: 'operation', kind, state: 'unknown', providerResult: null, error: null };
  props.state = { ...props.state, operations: new Map([[operation.operationId, operation]]) };
  const { container } = render(<SessionComposer {...props} operationProgress={new Map([[operation.operationId, 'sending']])} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Draft retained' } });
  expect(container.querySelector('.session-notice')).toBeNull();
  expect(screen.getByRole('button', { name: /Send|Awaiting provider confirmation/ })).toBeDisabled();
  expect(screen.getByRole('textbox')).toHaveValue('Draft retained');
});

it.each([
  ['en', 'Open chat commands', 'Refresh commands', 'Refreshing…', 'Reload'],
  ['zh-CN', '打开会话命令', '刷新命令', '正在刷新…', '重新加载'],
] as const)('presents catalog refresh, busy and failure states in %s without duplicate discovery', async (locale, open, refresh, refreshing, reload) => {
  const props = base();
  let finish!: () => void;
  props.onRefreshControls.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const view = createLocaleRender(locale)(<SessionComposer {...props} />);
  fireEvent.click(screen.getByRole('button', { name: open }));
  const button = screen.getByRole('button', { name: refresh });
  expect(button).toBeEnabled(); expect(button).toHaveAttribute('aria-busy', 'false');
  const user = userEvent.setup();
  button.focus(); await user.keyboard('{Enter}');
  expect(screen.getByRole('button', { name: refreshing })).toBeDisabled();
  expect(button).toHaveAttribute('aria-busy', 'true');
  fireEvent.click(button); expect(props.onRefreshControls).toHaveBeenCalledOnce();
  await act(async () => finish());
  expect(button).toHaveAccessibleName(refresh); expect(button).toHaveAttribute('aria-busy', 'false');
  const failed = { ...props.state, snapshot: { ...props.state.snapshot!, controls: { ...controls, commandsError: 'Native discovery failed' } } };
  view.rerender(<SessionComposer {...props} state={failed} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Native discovery failed');
  expect(button).toHaveAccessibleName(reload);
  fireEvent.click(button);
  expect(button).toHaveAccessibleName(refreshing); expect(button).toBeDisabled();
  await act(async () => finish());
  expect(button).toHaveAccessibleName(reload);
  view.rerender(<SessionComposer {...props} />);
  expect(button).toHaveAccessibleName(refresh); expect(screen.queryByRole('alert')).toBeNull();
  expect(props.onSend).not.toHaveBeenCalled(); expect(props.onExecuteCommand).not.toHaveBeenCalled();
});
