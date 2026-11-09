import { act, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { pauseAuthRequests } from '../src/api/client';
import { BotSessionHost } from '../src/features/bots/BotSessionHost';
import { getBotDisplaySnapshotCoordinator } from '../src/features/bots/display-snapshot-coordinator';
import type { BotDisplayPreview } from '../src/features/bots/display-snapshot';
import { BotSessionCache } from '../src/features/bots/session-cache';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { botBinding, botFixture, botOwner } from './helpers/bot-session';
import { createLocaleRender } from './helpers/renderWithLocale';
import { sessionFence } from '../../daynight/src/session/protocol';

const render = createLocaleRender('en');

it.each([false, true])('retains only the already visible preview during identity verification and honors revocation (resident: %s)', async resident => {
  const scope = createTaskCacheScope({ userId: botOwner, onIdentityMismatch: vi.fn() });
  const owner = getBotDisplaySnapshotCoordinator(scope);
  const bot = botFixture();
  vi.mocked(bot.api.timeline).mockReturnValue(new Promise(() => {}));
  const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => !scope.isInvalidated, storage: null, displaySnapshots: owner, onPrincipalMismatch: vi.fn(), createApi: () => bot.api });
  for (const number of [1, 2]) {
    const binding = botBinding(number);
    const preview: BotDisplayPreview = { schemaVersion: 1, ownerUserId: botOwner, botId: binding.botId, lastKnownBinding: binding, botName: 'Assistant', fence: number === 1 ? sessionFence(bot.snapshot()) : { sessionId: binding.sessionId, testExecutionId: binding.testExecutionId, executionGeneration: '1' }, historyEpoch: number === 1 ? bot.snapshot().historyEpoch : 'history', lastEventSeq: '1', entries: [{ kind: 'assistant_message', entryId: crypto.randomUUID(), entrySeq: '1', revision: '1', content: [{ type: 'text', text: `Private preview ${number}` }] }], resources: [], savedAt: 1 };
    const lease = await owner.store.observe(botOwner, binding.botId);
    await owner.store.save(lease!, { source: 'verified-history', historyLoaded: true, preview });
  }
  const read = vi.spyOn(owner.store, 'read'), save = vi.spyOn(owner.store, 'save');
  const node = (number: number) => <BotSessionHost cache={cache} botId={botBinding(number).botId} displayBinding={resident && number === 1 ? bot.binding : null} />;
  const view = render(node(1));
  let resume: (() => void) | undefined;
  try {
    const message = await screen.findByText('Private preview 1');
    const timeline = view.container.querySelector('.session-timeline');
    const reads = read.mock.calls.length;
    resume = pauseAuthRequests(); view.rerender(node(1));
    expect(screen.getByText('Private preview 1')).toBe(message);
    expect(view.container.querySelector('.session-timeline')).toBe(timeline);
    expect(read).toHaveBeenCalledTimes(reads);
    expect(save).not.toHaveBeenCalled();
    expect(await owner.store.observe(botOwner, botBinding(1).botId)).toBeNull();

    view.rerender(node(2));
    if (resident) expect(message).not.toBeVisible();
    else expect(screen.queryByText('Private preview 1')).toBeNull();
    expect(screen.queryByText('Private preview 2')).toBeNull();
    view.rerender(node(1));
    expect(screen.queryByText('Private preview 1')).toBeNull();
    expect(read).toHaveBeenCalledTimes(reads);
    expect(cache.snapshot()).toHaveLength(resident ? 1 : 0);

    resume(); resume = undefined; view.rerender(node(1));
    await screen.findByText('Private preview 1');
    resume = pauseAuthRequests(); view.rerender(node(1));
    act(() => owner.invalidateBot(botBinding(1).botId));
    expect(screen.queryByText('Private preview 1')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  } finally { resume?.(); view.unmount(); cache.close(); owner.close(); scope.dispose(); }
});
