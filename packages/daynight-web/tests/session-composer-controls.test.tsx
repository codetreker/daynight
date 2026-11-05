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
  if (mode === 'refreshing') fireEvent.click(screen.getByRole('button', { name: 'Retry commands' }));
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
  const element = target === 'option' ? screen.getByRole('option') : screen.getByRole('button', { name: target === 'close' ? 'Close' : 'Retry commands' });
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
