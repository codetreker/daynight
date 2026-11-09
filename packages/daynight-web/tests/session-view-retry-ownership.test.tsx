import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BotSessionHost } from '../src/features/bots/BotSessionHost';
import { BotSessionCache } from '../src/features/bots/session-cache';
import { ApiError } from '../src/api/client';
import { botFixture, botOwner } from './helpers/bot-session';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');

describe('Session retry ownership', () => {
  it.each([['cursor', 'Refresh'], ['cursor', 'Retry'], ['offline', 'Refresh']] as const)('retries sticky %s history with %s even when detail retry exists', async (failure, button) => {
    const bot = botFixture();
    const timeline = vi.mocked(bot.api.timeline);
    if (failure === 'cursor') timeline.mockResolvedValueOnce({ ...bot.page, hasMoreBefore: true, beforeCursor: null });
    else timeline.mockRejectedValueOnce(new ApiError('server', 503, 'controller_offline'));
    timeline.mockResolvedValue(bot.page);
    const retryDetail = vi.fn();
    const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, storage: null, onPrincipalMismatch: vi.fn(), createApi: () => bot.api });
    const rendered = render(<BotSessionHost cache={cache} displayBinding={bot.binding} actionBinding={bot.binding} onRetry={retryDetail} />);
    try {
      await waitFor(() => expect(cache.snapshot()[0]?.client.snapshot().status).toBe('error'));
      expect(timeline).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole('button', { name: button }));
      await screen.findByText(`Message ${bot.binding.botId}`);
      expect(cache.snapshot()[0]!.client.snapshot().historyLoaded).toBe(true);
      expect(cache.snapshot()[0]!.client.snapshot().error).toBeNull();
      expect(timeline).toHaveBeenCalledTimes(2);
      expect(retryDetail).not.toHaveBeenCalled();
    } finally { rendered.unmount(); cache.close(); }
  });

  it('retries a detail failure beside readable history without refreshing that history', async () => {
    const bot = botFixture(), retryDetail = vi.fn();
    const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, storage: null, onPrincipalMismatch: vi.fn(), createApi: () => bot.api });
    const rendered = render(<BotSessionHost cache={cache} displayBinding={bot.binding} actionBinding={bot.binding} error="Assistant details failed" onRetry={retryDetail} />);
    try {
      await screen.findByText(`Message ${bot.binding.botId}`);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(retryDetail).toHaveBeenCalledOnce();
      expect(bot.api.timeline).toHaveBeenCalledOnce();
      expect(bot.api.current).toHaveBeenCalledOnce();
    } finally { rendered.unmount(); cache.close(); }
  });

  it('uses the detail retry while no trusted binding or client exists', () => {
    const retryDetail = vi.fn();
    const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, storage: null, onPrincipalMismatch: vi.fn() });
    const rendered = render(<BotSessionHost cache={cache} botId="00000010-1111-4111-8111-111111111111" displayBinding={null} onRetry={retryDetail} />);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(retryDetail).toHaveBeenCalledOnce();
      expect(cache.snapshot()).toHaveLength(0);
    } finally { rendered.unmount(); cache.close(); }
  });
});
