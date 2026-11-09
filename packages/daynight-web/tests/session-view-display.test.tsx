import { readFileSync } from 'node:fs';
import { createRef } from 'react';
import { act, fireEvent, screen, within, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '../src/api/types';
import { TaskSessionClient, type SessionViewState } from '../src/features/task-agent-session/client';
import { SessionView } from '../src/features/task-agent-session/SessionView';
import { emptySessionState } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';
import { BotConversationHeader, type BotConversationTarget } from '../src/features/bots/BotConversationHeader';
import { botFixture, botOwner } from './helpers/bot-session';
import { botDefinition } from './helpers/bots';
import { sessionFence, type SessionOperation } from '../../daynight/src/session/protocol';

const render = createLocaleRender('en');
let sequence = 0;
function fixture() {
  const snapshot: SessionSnapshot = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
  const userId = `display-user-${++sequence}`;
  let view: SessionViewState = { actionAdmitted: true, operationProgress: new Map(), startupReport: null, errorCode: null, environmentConnected: true, historyReady: true, historyRevision: 1, connectionGeneration: 1, state: { ...emptySessionState(), snapshot, entries: [
    { entryId: 'message', entrySeq: '1', revision: '1', kind: 'assistant_message', content: [{ type: 'text', text: 'Keep this message' }] },
    { entryId: 'thought', entrySeq: '2', revision: '1', kind: 'reasoning', text: 'Private reasoning' },
  ] }, archiveState: null, settingIntents: new Map(), draft: { text: 'Keep this draft', revision: '1', submission: null }, status: 'ready', connected: true, authPaused: false, error: 'Connection diagnostic', hasOlder: false, loadingOlder: false, historyError: null, checking: new Set() };
  const listeners = new Set<() => void>();
  const client = { subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }, snapshot: () => view, canInteract: () => true, refresh: vi.fn(), loadOlder: vi.fn(), resource: vi.fn(), respond: vi.fn(), setDraft: vi.fn(), send: vi.fn(), cancel: vi.fn(), updateSetting: vi.fn(), executeCommand: vi.fn(), refreshControls: vi.fn() } as unknown as TaskSessionClient;
  return { client, userId, snapshot, key: (user = userId, session = snapshot.sessionId) => `daynight.web.session.display.v1:${JSON.stringify([user, session])}`, update: (next: Partial<SessionViewState>) => act(() => { view = { ...view, ...next }; listeners.forEach(listener => listener()); }), get: () => view };
}

it('defaults to Conversation and switches without replacing Composer or retained messages', () => {
  const f = fixture(); const rendered = render(<SessionView client={f.client} userId={f.userId} active current />);
  expect(screen.queryByText('Reasoning')).toBeNull();
  const composer = screen.getByRole('textbox'), message = screen.getByText('Keep this message');
  expect(localStorage.getItem(f.key())).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Display' }));
  expect(screen.getByRole('menuitemradio', { name: 'Conversation' })).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Standard' }));
  expect(screen.getByText('Reasoning')).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toBe(composer);
  expect(composer).toHaveValue('Keep this draft');
  expect(screen.getByText('Keep this message')).toBe(message);
  expect(screen.getByText('Connection diagnostic')).toBeVisible();
  expect(localStorage.getItem(f.key())).toBe('"standard"');
  expect(f.client.refresh).not.toHaveBeenCalled(); expect(f.client.send).not.toHaveBeenCalled(); expect(f.client.respond).not.toHaveBeenCalled();
  rendered.setLocale('zh-CN');
  expect(screen.getByRole('menuitemradio', { name: '标准' })).toHaveAttribute('aria-checked', 'true');
});

it('restores saved Standard, isolates identity synchronously and shares two views of one Session', () => {
  const f = fixture(); localStorage.setItem(f.key(), '"standard"');
  const element = (userId = f.userId) => <><SessionView client={f.client} userId={userId} active current /><SessionView client={f.client} userId={userId} active current /></>;
  const rendered = render(element());
  expect(screen.getAllByText('Reasoning')).toHaveLength(2);
  fireEvent.click(screen.getAllByRole('button', { name: 'Display' })[0]!);
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Conversation' }));
  expect(screen.queryByText('Reasoning')).toBeNull();
  rendered.rerender(element(`${f.userId}-other`));
  expect(screen.queryByText('Reasoning')).toBeNull();
  expect(localStorage.getItem(f.key(`${f.userId}-other`))).toBeNull();
});

it('keeps unsaved selection, exposes storage errors only in the menu and retries the current choice', () => {
  const f = fixture(); const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
  render(<SessionView client={f.client} userId={f.userId} active current />);
  fireEvent.click(screen.getByRole('button', { name: 'Display' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Standard' }));
  expect(screen.getByText('Reasoning')).toBeInTheDocument();
  expect(within(screen.getByRole('menu')).getByRole('alert')).toHaveTextContent(/save/i);
  fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Standard' }), { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  save.mockRestore();
  fireEvent.click(screen.getByRole('button', { name: 'Display' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /retry/i }));
  expect(localStorage.getItem(f.key())).toBe('"standard"');
  expect(within(screen.getByRole('menu')).queryByRole('alert')).toBeNull();
});

it('retains the selection when a Session becomes a readable archive', () => {
  const f = fixture(); render(<SessionView client={f.client} userId={f.userId} active current />);
  fireEvent.click(screen.getByRole('button', { name: 'Display' })); fireEvent.click(screen.getByRole('menuitemradio', { name: 'Standard' }));
  f.update({ state: { ...f.get().state, snapshot: { ...f.snapshot, lifecycle: 'archived' } }, archiveState: 'ready' });
  expect(screen.getByText('Reasoning')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('menuitemradio', { name: 'Standard' })).toHaveAttribute('aria-checked', 'true');
});

it('does not read preferences for unavailable or unresolved Session identity', () => {
  const f = fixture(); f.update({ status: 'unavailable' });
  const read = vi.spyOn(Storage.prototype, 'getItem');
  const rendered = render(<SessionView client={f.client} userId={f.userId} active current />);
  expect(read.mock.calls.filter(([key]) => key.startsWith('daynight.web.session.display.'))).toEqual([]);
  f.update({ status: 'ready', state: { ...f.get().state, snapshot: null } });
  rendered.rerender(<SessionView client={f.client} userId={f.userId} active current />);
  expect(read.mock.calls.filter(([key]) => key.startsWith('daynight.web.session.display.'))).toEqual([]);
});

it('closes Display before the enclosing dialog even while the Chatbox keyboard hint was hovered', () => {
  const f = fixture(), outerEscape = vi.fn();
  render(<div onKeyDown={event => { if (event.key === 'Escape') outerEscape(); }}><SessionView client={f.client} userId={f.userId} active current /></div>);
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'Send' }).parentElement!);
  const trigger = screen.getByRole('button', { name: 'Display' }); fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Conversation' }), { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull(); expect(trigger).toHaveFocus(); expect(outerEscape).not.toHaveBeenCalled();
});

it('abandons an in-flight history error when the authenticated account changes', async () => {
  const f = fixture(); f.update({ error: null }); let reject!: (error: Error) => void;
  vi.mocked(f.client.loadOlder).mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const view = render(<SessionView client={f.client} userId={f.userId} active current />);
  const box = view.container.querySelector<HTMLElement>('.session-timeline')!;
  Object.defineProperties(box, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, value: 100 } });
  f.update({ hasOlder: true });
  await waitFor(() => expect(f.client.loadOlder).toHaveBeenCalledTimes(1));
  view.rerender(<SessionView client={f.client} userId="another-account" active current />);
  await act(async () => { reject(new Error('The previous account history failed')); await Promise.resolve(); });
  expect(screen.queryByText('The previous account history failed')).toBeNull();
});


it.each(['default', 'assistant'] as const)('keeps approvals and timeline errors actionable through %s display changes without replaying a response', async consumer => {
  const bot = botFixture(), snapshot = bot.snapshot();
  bot.change({ ...snapshot, activity: 'waiting_input', operations: { ...snapshot.operations, canSend: false, canRespond: true } });
  vi.mocked(bot.api.timeline).mockResolvedValue({ ...bot.page, items: [
    ...bot.page.items,
    { entryId: 'reasoning', entrySeq: '2', revision: '1', kind: 'reasoning', text: 'Intermediate reasoning' },
    { entryId: 'approval', entrySeq: '3', revision: '1', kind: 'interaction', interaction: { interactionId: 'write-approval', revision: '1', state: 'pending', kind: 'approval', title: 'Approve workspace write', detail: 'notes/review.txt', actions: ['allow_once', 'reject'] } },
    { entryId: 'error', entrySeq: '4', revision: '1', kind: 'error', code: 'write_failed', message: 'Previous workspace write failed' },
  ] });
  const response = Promise.withResolvers<SessionOperation>();
  vi.mocked(bot.api.command).mockImplementation(() => response.promise);
  const client = new TaskSessionClient({ api: bot.api, userId: botOwner, testSessionId: bot.binding.sessionId, isCurrent: () => true, onPrincipalMismatch: vi.fn(), storage: null });
  const definition = { ...botDefinition(), id: bot.binding.botId, ownerUserId: botOwner };
  const target: BotConversationTarget = { bot: definition, name: definition.name, worker: undefined, stale: false, detailsId: 'details', detailsOpen: false, detailsOpener: createRef(), onDetails: vi.fn(), follow: vi.fn(event => event.preventDefault()) };
  const presentation = consumer === 'assistant' ? { variant: 'assistant' as const, renderHeader: (slot: import('../src/features/task-agent-session/session-presentation-slots').SessionHeaderSlot) => <BotConversationHeader target={target} session={slot} /> } : undefined;
  const view = render(<SessionView client={client} userId={botOwner} active current {...(presentation ? { presentation } : {})} />);
  try {
    await act(async () => { await client.start(); });
    const approval = await screen.findByRole('button', { name: 'Allow once' });
    await waitFor(() => expect(approval).toBeEnabled());
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: 'Draft beside approval' } });
    const timeline = view.container.querySelector('.session-timeline'), error = screen.getByText('Previous workspace write failed');
    expect(error).toBeVisible();
    expect(screen.queryByText('Reasoning')).toBeNull();
    const select = (mode: 'Standard' | 'Conversation') => {
      fireEvent.click(screen.getByRole('button', { name: 'Display' }));
      fireEvent.click(screen.getByRole('menuitemradio', { name: mode }));
      fireEvent.keyDown(screen.getByRole('menuitemradio', { name: mode }), { key: 'Escape' });
    };
    select('Standard');
    expect(screen.getByText('Reasoning')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Allow once' })).toBe(approval);
    expect(approval).toBeEnabled();
    expect(screen.getByText('Previous workspace write failed')).toBe(error);
    expect(bot.api.command).not.toHaveBeenCalled();
    select('Conversation');
    expect(screen.getByText('Previous workspace write failed')).toBe(error);
    expect(approval).toBeVisible();
    fireEvent.click(approval);
    await waitFor(() => expect(bot.api.command).toHaveBeenCalledOnce());
    expect(approval).toBeDisabled();
    const command = vi.mocked(bot.api.command).mock.calls[0]![1];
    expect(command).toMatchObject({ kind: 'interaction_response', payload: { interactionId: 'write-approval', interactionRevision: '1', response: { kind: 'approval', action: 'allow_once' } } });
    select('Standard');
    select('Conversation');
    expect(screen.getByRole('button', { name: 'Allow once' })).toBe(approval);
    expect(approval).toBeDisabled();
    fireEvent.click(approval);
    expect(bot.api.command).toHaveBeenCalledOnce();
    expect(screen.getByText('Previous workspace write failed')).toBe(error);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input);
    expect(input).toHaveValue('Draft beside approval');
    expect(view.container.querySelector('.session-timeline')).toBe(timeline);
    await act(async () => { response.resolve({ protocol: snapshot.protocol, ...sessionFence(snapshot), operationId: command.operationId, kind: command.kind, state: 'confirmed', providerResult: null, error: null }); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull());
    expect(bot.api.command).toHaveBeenCalledOnce();
    expect(bot.api.current).toHaveBeenCalledOnce();
    expect(bot.api.channel).toHaveBeenCalledOnce();
  } finally { view.unmount(); client.close(); }
});
