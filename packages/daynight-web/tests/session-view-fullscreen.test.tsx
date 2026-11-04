import { readFileSync } from 'node:fs';
import { act, fireEvent, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '../src/api/types';
import type { TaskSessionClient, SessionViewState } from '../src/features/task-agent-session/client';
import { SessionView } from '../src/features/task-agent-session/SessionView';
import { emptySessionState } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
let sequence = 0;
function fixture() {
  const snapshot: SessionSnapshot = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
  const userId = `display-user-${++sequence}`;
  let view: SessionViewState = { historyReady: true, historyRevision: 1, connectionGeneration: 1, state: { ...emptySessionState(), snapshot, entries: [
    { entryId: 'message', entrySeq: '1', revision: '1', kind: 'assistant_message', content: [{ type: 'text', text: 'Keep this message' }] },
    { entryId: 'thought', entrySeq: '2', revision: '1', kind: 'reasoning', text: 'Private reasoning' },
  ] }, archiveState: null, settingIntents: new Map(), draft: { text: 'Keep this draft', revision: '1', submission: null }, status: 'ready', connected: true, authPaused: false, error: 'Connection diagnostic', hasOlder: false, loadingOlder: false, historyError: null, checking: new Set() };
  const listeners = new Set<() => void>();
  const client = { subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }, snapshot: () => view, refresh: vi.fn(), loadOlder: vi.fn(), resource: vi.fn(), respond: vi.fn(), setDraft: vi.fn(), send: vi.fn(), cancel: vi.fn(), updateSetting: vi.fn(), executeCommand: vi.fn(), refreshControls: vi.fn() } as unknown as TaskSessionClient;
  return { client, userId, snapshot, key: (user = userId, session = snapshot.sessionId) => `daynight.web.session.display.v1:${JSON.stringify([user, session])}`, update: (next: Partial<SessionViewState>) => act(() => { view = { ...view, ...next }; listeners.forEach(listener => listener()); }), get: () => view };
}

it('keeps the same view, composer and draft while fullscreen owns Escape before its parent', () => {
  const f = fixture(), outerEscape = vi.fn();
  const rendered = render(<div onKeyDown={event => { if (event.key === 'Escape') outerEscape(); }}><SessionView client={f.client} userId={f.userId} active current /></div>);
  const section = screen.getByRole('region', { name: 'Session' });
  const composer = screen.getByRole('textbox'), message = screen.getByText('Keep this message');
  const trigger = screen.getByRole('button', { name: 'Enter Session fullscreen' });
  fireEvent.click(trigger);
  expect(section).toHaveClass('session-fullscreen');
  expect(screen.getByRole('textbox')).toBe(composer);
  expect(composer).toHaveValue('Keep this draft');
  expect(screen.getByText('Keep this message')).toBe(message);
  expect(screen.getByRole('button', { name: 'Exit Session fullscreen' })).toBe(trigger);
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.click(screen.getByRole('button', { name: 'Display' }));
  fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Conversation' }), { key: 'Escape' });
  expect(section).toHaveClass('session-fullscreen');
  expect(outerEscape).not.toHaveBeenCalled();
  fireEvent.keyDown(composer, { key: 'Escape' });
  expect(section).not.toHaveClass('session-fullscreen');
  expect(trigger).toHaveFocus();
  expect(document.body.style.overflow).toBe('');
  expect(outerEscape).not.toHaveBeenCalled();
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(outerEscape).toHaveBeenCalledOnce();
  expect(f.client.refresh).not.toHaveBeenCalled();
  expect(f.client.send).not.toHaveBeenCalled();
  expect(localStorage.getItem(f.key())).toBeNull();
  rendered.setLocale('zh-CN');
  expect(screen.getByRole('button', { name: '会话全屏' })).toBe(trigger);
});

it.each(['loading', 'not_registered', 'unavailable', 'error'] as const)('retains the same fullscreen exit through %s and recovery', status => {
  const f = fixture(); render(<SessionView client={f.client} userId={f.userId} active current />);
  const section = screen.getByRole('region', { name: 'Session' });
  const trigger = screen.getByRole('button', { name: 'Enter Session fullscreen' });
  fireEvent.click(trigger);
  const state = f.get().state;
  f.update({ status, state: { ...state, snapshot: null } });
  expect(screen.getByRole('region', { name: 'Session' })).toBe(section);
  expect(screen.getByRole('button', { name: 'Exit Session fullscreen' })).toBe(trigger);
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  f.update({ status: 'ready', state });
  expect(section).toHaveClass('session-fullscreen');
  fireEvent.click(trigger);
  expect(section).not.toHaveClass('session-fullscreen');
});

it('keeps fullscreen and a reachable exit during archive preparation and read-only history', () => {
  const f = fixture(); render(<SessionView client={f.client} userId={f.userId} active current />);
  fireEvent.click(screen.getByRole('button', { name: 'Enter Session fullscreen' }));
  f.update({ state: { ...f.get().state, snapshot: { ...f.snapshot, lifecycle: 'draining' } }, archiveState: 'pending' });
  expect(screen.getByRole('button', { name: 'Exit Session fullscreen' })).toBeVisible();
  expect(screen.queryByRole('textbox')).toBeNull();
  f.update({ state: { ...f.get().state, snapshot: { ...f.snapshot, lifecycle: 'archived' } }, archiveState: 'ready' });
  expect(screen.getByText('Keep this message')).toBeVisible();
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Exit Session fullscreen' }), { key: 'Escape' });
  expect(document.body.style.overflow).toBe('');
});

it('does not carry fullscreen across inactive or replacement identities', () => {
  const f = fixture();
  const element = (active = true, userId = f.userId) => <SessionView client={f.client} userId={userId} active={active} current />;
  const view = render(element());
  fireEvent.click(screen.getByRole('button', { name: 'Enter Session fullscreen' }));
  view.rerender(element(false));
  expect(document.body.style.overflow).toBe('');
  view.rerender(element());
  expect(screen.getByRole('region', { name: 'Session' })).not.toHaveClass('session-fullscreen');
  fireEvent.click(screen.getByRole('button', { name: 'Enter Session fullscreen' }));
  view.rerender(element(true, 'another-user'));
  expect(screen.getByRole('region', { name: 'Session' })).not.toHaveClass('session-fullscreen');
});

it('restores a safe Session focus when archive preparation removes the focused composer', async () => {
  const f = fixture(); render(<SessionView client={f.client} userId={f.userId} active current />);
  fireEvent.click(screen.getByRole('button', { name: 'Enter Session fullscreen' }));
  screen.getByRole('textbox').focus();
  f.update({ state: { ...f.get().state, snapshot: { ...f.snapshot, lifecycle: 'draining' } }, archiveState: 'pending' });
  await act(async () => {});
  expect(screen.getByRole('region', { name: 'Session' })).toContainElement(document.activeElement as HTMLElement);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Enter Session fullscreen' })).toBeVisible();
});

it('closes commands before Session fullscreen even when focus has moved to its header', () => {
  const f = fixture(), outer = vi.fn();
  render(<div onKeyDown={outer}><SessionView client={f.client} userId={f.userId} active current /></div>);
  fireEvent.click(screen.getByRole('button', { name: 'Enter Session fullscreen' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open chat commands' }));
  const refresh = screen.getByRole('button', { name: 'Refresh' }); refresh.focus();
  fireEvent.keyDown(refresh, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByRole('region', { name: 'Session' })).toHaveClass('session-fullscreen');
  expect(screen.getByRole('textbox')).toHaveFocus(); expect(outer).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  expect(screen.getByRole('region', { name: 'Session' })).not.toHaveClass('session-fullscreen');
});

it('keeps composition Escape inside the command layer without cancelling fullscreen', () => {
  const f = fixture(), outer = vi.fn();
  render(<div onKeyDown={outer}><SessionView client={f.client} userId={f.userId} active current /></div>);
  fireEvent.click(screen.getByRole('button', { name: 'Enter Session fullscreen' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open chat commands' }));
  const input = screen.getByRole('textbox');
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    expect(fireEvent.keyDown(input, { key: 'Escape', ...composition, cancelable: true })).toBe(true);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Session' })).toHaveClass('session-fullscreen');
  }
  expect(outer).not.toHaveBeenCalled();
});
