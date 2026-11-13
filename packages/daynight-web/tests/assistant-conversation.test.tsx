import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { sessionBinding, type SessionCommand } from '../../daynight/src/session/protocol';
import type { SessionOperation, SessionSnapshot } from '../src/api/types';
import { BotSessionHost } from '../src/features/bots/BotSessionHost';
import { BotSessionCache } from '../src/features/bots/session-cache';
import { SessionDraftStore } from '../src/features/task-agent-session/drafts/draft-store';
import { botBinding, botFixture, botOwner } from './helpers/bot-session';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const caches: BotSessionCache[] = [];
afterEach(() => caches.splice(0).forEach(cache => cache.close()));

function receipt(command: SessionCommand): SessionOperation {
  return { protocol: command.protocol, sessionId: command.sessionId, ...sessionBinding(command), executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state: 'provider_accepted', providerResult: 'started', error: null };
}

function fixture({ empty = false, working = false, steer = true, configure }: { empty?: boolean; working?: boolean; steer?: boolean; configure?: (bot: ReturnType<typeof botFixture>) => void } = {}) {
  const bots = [1, 2, 3, 4].map(n => {
    const bot = botFixture(botBinding(n)), snapshot = bot.snapshot();
    if (empty) vi.mocked(bot.api.timeline).mockResolvedValue({ ...bot.page, items: [] });
    if (working) bot.change({ ...snapshot, activity: 'working', currentTurnId: `turn-${n}`, capabilities: { ...snapshot.capabilities, steer }, operations: { ...snapshot.operations, canSend: steer, canCancel: true } });
    vi.mocked(bot.api.command).mockImplementation(async (_id, command) => receipt(command));
    configure?.(bot);
    return bot;
  });
  let paused = false;
  const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, isPaused: () => paused, storage: null, onPrincipalMismatch: vi.fn(), createApi: binding => bots.find(bot => bot.binding.botId === binding.botId)!.api });
  caches.push(cache);
  const view = render(<BotSessionHost cache={cache} displayBinding={bots[0]!.binding} actionBinding={bots[0]!.binding} />);
  return {
    bots, cache, view,
    select: async (index: number) => {
      view.rerender(<BotSessionHost cache={cache} displayBinding={bots[index]!.binding} actionBinding={bots[index]!.binding} />);
      const input = await screen.findByRole('textbox', { name: 'Message' });
      await waitFor(() => expect(input).toBeEnabled());
      await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
      return input;
    },
    pause: (value: boolean) => act(() => { paused = value; cache.syncAvailability(); }),
    publish: (patch: Partial<SessionSnapshot>) => act(() => {
      const bot = bots[0]!, snapshot = { ...bot.snapshot(), ...patch, sessionRevision: String(BigInt(bot.snapshot().sessionRevision) + 1n) } as SessionSnapshot;
      bot.change(snapshot);
      bot.receive({ protocol: snapshot.protocol, type: 'snapshot', userId: botOwner, snapshot, cursor: 'updated' });
    }),
  };
}

it('fills and focuses each localized assistant suggestion without sending or replacing the timeline', async () => {
  const f = fixture({ empty: true }), input = await f.select(0);
  const timeline = f.view.container.querySelector('.session-timeline');
  await screen.findByRole('heading', { name: 'Start with a conversation' });
  const starters = f.view.container.querySelector('.bot-conversation-starters')!;
  expect(within(starters as HTMLElement).getAllByRole('button')).toHaveLength(3);
  const englishPrompts = ['Show me which tasks are running right now', 'Help me break this idea into smaller tasks', 'Help me work out what to prioritize today'];
  for (const [index, button] of within(starters as HTMLElement).getAllByRole('button').entries()) {
    const revision = f.cache.snapshot()[0]!.client.snapshot().draft.revision;
    fireEvent.click(button);
    expect(input).toHaveFocus();
    expect(input).toHaveValue(englishPrompts[index]);
    expect(f.cache.snapshot()[0]!.client.snapshot().draft.revision).not.toBe(revision);
    expect(f.cache.snapshot()[0]!.client.snapshot().draft.text).toBe((input as HTMLTextAreaElement).value);
    expect(f.view.container.querySelector('.session-timeline')).toBe(timeline);
  }
  f.view.setLocale('zh-CN');
  await screen.findByRole('heading', { name: '从一段对话开始' });
  expect(screen.getByRole('textbox', { name: '消息' })).toBe(input);
  const chinesePrompts = ['看看我现在有哪些任务在执行', '帮我把这个想法拆成几个小任务', '帮我梳理今天应该优先处理什么'];
  for (const [index, button] of within(starters as HTMLElement).getAllByRole('button').entries()) {
    fireEvent.click(button);
    expect(input).toHaveFocus();
    expect(input).toHaveValue(chinesePrompts[index]);
  }
  expect(f.bots[0]!.api.command).not.toHaveBeenCalled();
});

it('waits for draft restoration before offering a conversation suggestion', async () => {
  const pending = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), read = SessionDraftStore.prototype.reconcileAuthorizedOwner;
  const heldRead = vi.spyOn(SessionDraftStore.prototype, 'reconcileAuthorizedOwner').mockImplementationOnce(async function (this: SessionDraftStore, ...args) {
    entered.resolve(); await pending.promise;
    return read.apply(this, args);
  });
  const f = fixture({ empty: true });
  try {
    const input = await screen.findByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(f.cache.snapshot()[0]!.client.snapshot().historyReady).toBe(true));
    await act(async () => entered.promise);
    expect(heldRead).toHaveBeenCalledWith(expect.anything(), expect.any(Function));
    expect(input).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'See which tasks are running' })).toBeNull();
    await act(async () => pending.resolve());
    fireEvent.click(await screen.findByRole('button', { name: 'See which tasks are running' }));
    expect(input).toHaveValue('Show me which tasks are running right now');
    expect(f.bots[0]!.api.command).not.toHaveBeenCalled();
  } finally {
    await act(async () => pending.resolve());
    heldRead.mockRestore();
  }
});

it('retains a suggestion draft through A/B/A selection and eviction without issuing input', async () => {
  const f = fixture({ empty: true }), a = await f.select(0);
  fireEvent.click(await screen.findByRole('button', { name: 'See which tasks are running' }));
  const draft = (a as HTMLTextAreaElement).value, timeline = a.closest('.task-agent-session')!.querySelector('.session-timeline');
  const b = await f.select(1);
  fireEvent.change(b, { target: { value: 'Independent B draft' } });
  await f.select(0);
  expect(screen.getByRole('textbox')).toBe(a);
  expect(a).toHaveValue(draft);
  expect(a.closest('.task-agent-session')!.querySelector('.session-timeline')).toBe(timeline);
  await f.select(1); await f.select(2); await f.select(3);
  expect(a.isConnected).toBe(false);
  expect(f.bots[0]!.channel.close).toHaveBeenCalledOnce();
  const restored = await f.select(0);
  expect(restored).not.toBe(a);
  expect(restored).toHaveValue(draft);
  expect(f.bots.every(bot => vi.mocked(bot.api.command).mock.calls.length === 0)).toBe(true);
});

it('keeps later drafts in both assistants when the original bound send is acknowledged after switching', async () => {
  const f = fixture(), a = await f.select(0), pending = Promise.withResolvers<SessionOperation>();
  vi.mocked(f.bots[0]!.api.command).mockReturnValueOnce(pending.promise);
  fireEvent.change(a, { target: { value: 'Send to A once' } });
  fireEvent.keyDown(a, { key: 'Enter' });
  await waitFor(() => expect(f.bots[0]!.api.command).toHaveBeenCalledOnce());
  const [id, command] = vi.mocked(f.bots[0]!.api.command).mock.calls[0]!;
  expect(id).toBe(f.bots[0]!.binding.sessionId);
  expect(command).toMatchObject({ kind: 'send_message', testExecutionId: f.bots[0]!.binding.testExecutionId, payload: { content: [{ type: 'text', text: 'Send to A once' }], expectedTurnId: null } });
  fireEvent.change(a, { target: { value: 'New A draft' } });
  const b = await f.select(1);
  fireEvent.change(b, { target: { value: 'New B draft' } });
  await act(async () => pending.resolve(receipt(command)));
  expect(b).toHaveValue('New B draft');
  await f.select(0);
  expect(a).toHaveValue('New A draft');
  expect(f.bots[0]!.api.command).toHaveBeenCalledOnce();
  expect(f.bots[1]!.api.command).not.toHaveBeenCalled();
});

it.each([true, false])('uses Enter only for supported steering and keeps Interrupt independent (steer: %s)', async steer => {
  const f = fixture({ working: true, steer }), input = await f.select(0);
  fireEvent.change(input, { target: { value: 'Supplement the current turn' } });
  for (const ime of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }]) fireEvent.keyDown(input, { key: 'Enter', ...ime });
  fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.compositionEnd(input);
  expect(f.bots[0]!.api.command).not.toHaveBeenCalled();
  const supplement = screen.getByRole('button', { name: 'Add to current turn' }), interrupt = screen.getByRole('button', { name: 'Interrupt' });
  expect(interrupt).toBeEnabled(); expect(interrupt).toHaveAttribute('type', 'button');
  if (steer) expect(supplement).toBeEnabled(); else expect(supplement).toBeDisabled();
  fireEvent.keyDown(input, { key: 'Enter' });
  if (steer) {
    await waitFor(() => expect(input).toHaveValue(''));
    expect(vi.mocked(f.bots[0]!.api.command).mock.calls[0]![1]).toMatchObject({ kind: 'send_message', payload: { expectedTurnId: 'turn-1' } });
  } else expect(f.bots[0]!.api.command).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: 'Keep while stopping' } });
  fireEvent.click(interrupt);
  await waitFor(() => expect(f.bots[0]!.api.command).toHaveBeenCalledTimes(steer ? 2 : 1));
  expect(vi.mocked(f.bots[0]!.api.command).mock.calls.at(-1)![1]).toMatchObject({ kind: 'cancel', payload: { expectedTurnId: 'turn-1' } });
  expect(input).toHaveValue('Keep while stopping');
});

it('checks an unknown assistant submission by its original operation and preserves a later draft', async () => {
  const f = fixture(), input = await f.select(0), bot = f.bots[0]!;
  vi.mocked(bot.api.command).mockRejectedValueOnce(new Error('Lost acknowledgement'));
  fireEvent.change(input, { target: { value: 'Deliver once' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const check = await screen.findByRole('button', { name: 'Check original operation' });
  // The recovery row can appear before the composer finishes the rejected send.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled());
  const command = vi.mocked(bot.api.command).mock.calls[0]![1];
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  fireEvent.change(input, { target: { value: 'Next draft' } });
  vi.mocked(bot.api.operation).mockResolvedValue({ ...receipt(command), state: 'confirmed' });
  fireEvent.click(check);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Check original operation' })).toBeNull());
  expect(bot.api.operation).toHaveBeenCalledExactlyOnceWith(bot.binding.sessionId, command.operationId, expect.any(AbortSignal));
  expect(bot.api.command).toHaveBeenCalledOnce();
  expect(input).toHaveValue('Next draft');
});

it('preserves local empty-conversation editing during identity verification but blocks transmission', async () => {
  const f = fixture({ empty: true }), input = await f.select(0);
  const starter = await screen.findByRole('button', { name: 'See which tasks are running' });
  f.pause(true);
  fireEvent.click(starter);
  expect(input).toHaveFocus();
  expect((input as HTMLTextAreaElement).value).not.toBe('');
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(f.bots[0]!.api.command).not.toHaveBeenCalled();
  f.pause(false);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  expect(screen.getByRole('textbox')).toBe(input);
  expect(f.bots[0]!.api.channel).toHaveBeenCalledOnce();
});

it.each(['offline', 'read-only'] as const)('removes the welcome layer and blocks writes when the assistant becomes %s', async mode => {
  const f = fixture({ empty: true }), input = await f.select(0);
  await screen.findByRole('heading', { name: 'Start with a conversation' });
  fireEvent.change(input, { target: { value: 'Retain private draft' } });
  f.publish(mode === 'offline' ? { connectionState: 'disconnected' } : { lifecycle: 'draining' });
  expect(screen.queryByRole('heading', { name: 'Start with a conversation' })).toBeNull();
  const currentInput = screen.queryByRole('textbox');
  if (mode === 'offline') {
    expect(currentInput).toBe(input);
    expect(currentInput).toHaveValue('Retain private draft');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
  } else expect(currentInput).toBeNull();
  expect(f.cache.snapshot()[0]!.client.snapshot().state.snapshot?.lifecycle).toBe(mode === 'offline' ? 'active' : 'draining');
  expect(f.bots[0]!.api.command).not.toHaveBeenCalled();
});

it('waits for the empty history response before offering assistant suggestions', async () => {
  const pending = Promise.withResolvers<ReturnType<typeof botFixture>['page']>();
  const f = fixture({ configure: bot => { vi.mocked(bot.api.timeline).mockReturnValue(pending.promise); } });
  await waitFor(() => expect(f.bots[0]!.api.timeline).toHaveBeenCalledOnce());
  expect(screen.queryByRole('heading', { name: 'Start with a conversation' })).toBeNull();
  await act(async () => pending.resolve({ ...f.bots[0]!.page, items: [] }));
  await screen.findByRole('heading', { name: 'Start with a conversation' });
  expect(f.bots[0]!.api.command).not.toHaveBeenCalled();
});

it.each(['older-history', 'history-error', 'filtered-process', 'working'] as const)('does not mistake %s for a new empty conversation', async mode => {
  const f = fixture({ empty: true, working: mode === 'working', configure: bot => {
    if (mode === 'older-history') vi.mocked(bot.api.timeline).mockResolvedValue({ ...bot.page, items: [], hasMoreBefore: true, beforeCursor: 'earlier' });
    if (mode === 'history-error') vi.mocked(bot.api.timeline).mockRejectedValue(new Error('History is unavailable'));
    if (mode === 'filtered-process') vi.mocked(bot.api.timeline).mockResolvedValue({ ...bot.page, items: [{ kind: 'reasoning', entryId: 'reasoning', entrySeq: '1', revision: '1', text: 'Private process' }] });
  } });
  if (mode === 'history-error') await screen.findByText('History is unavailable');
  else {
    await f.select(0);
    await waitFor(() => expect(f.cache.snapshot()[0]!.client.snapshot().historyReady).toBe(true));
  }
  expect(screen.queryByRole('heading', { name: 'Start with a conversation' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'See which tasks are running' })).toBeNull();
  expect(f.bots[0]!.api.command).not.toHaveBeenCalled();
});

it('prevents a deleted assistant from reopening private content or reading through an old selection', async () => {
  const f = fixture({ empty: true }), a = await f.select(0);
  fireEvent.click(await screen.findByRole('button', { name: 'See which tasks are running' }));
  const b = await f.select(1);
  fireEvent.change(b, { target: { value: 'Keep B available' } });
  const bot = f.bots[0]!;
  const reads = [bot.api.current, bot.api.timeline, bot.api.channel, bot.api.operation].map(api => vi.mocked(api).mock.calls.length);
  act(() => f.cache.invalidateBot(bot.binding.botId, bot.binding.sessionId));
  expect(a.isConnected).toBe(false);
  f.view.rerender(<BotSessionHost cache={f.cache} displayBinding={bot.binding} actionBinding={bot.binding} />);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Start with a conversation' })).toBeNull();
  await f.select(1);
  expect(screen.getByRole('textbox')).toBe(b);
  expect(b).toHaveValue('Keep B available');
  expect([bot.api.current, bot.api.timeline, bot.api.channel, bot.api.operation].map(api => vi.mocked(api).mock.calls.length)).toEqual(reads);
  expect(bot.channel.close).toHaveBeenCalledOnce();
  expect(f.bots.every(item => vi.mocked(item.api.command).mock.calls.length === 0)).toBe(true);
});
