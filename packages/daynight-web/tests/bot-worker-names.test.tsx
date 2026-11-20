import { createRef } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as aliases from '../src/api/worker-alias';
import * as bots from '../src/api/bots';
import * as readApi from '../src/api/worker-readonly';
import { BotCreateForm } from '../src/features/bots/BotCreateForm';
import { BotDetailsPanel } from '../src/features/bots/BotDetailsPanel';
import { BotStatus } from '../src/features/bots/BotStatus';
import { renderWithLocale } from './helpers/renderWithLocale';
import { BOT_USER, botDefaults, botDefinition, botId, botWorkerDefaults } from './helpers/bots';
import { botObservation } from './helpers/bot-observation';

const observation = (n = 1, worker = 20) => ({ value: botObservation(n, { workerId: botId(worker), machine: { id: `machine-${worker}`, name: `Machine ${worker}` } }), stale: false, busy: false, error: null, refresh: vi.fn() });

vi.mock('../src/api/worker-alias', async original => ({ ...await original<typeof aliases>(), getWorkerAlias: vi.fn() }));
vi.mock('../src/api/bots', async original => ({ ...await original<typeof bots>(), getBotDefaults: vi.fn(), createBot: vi.fn() }));
vi.mock('../src/api/worker-readonly', async original => ({ ...await original<typeof readApi>(), browseWorkerDirectory: vi.fn(), discoverWorkerModels: vi.fn() }));
const flush = () => act(async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); });

beforeEach(() => {
  vi.mocked(aliases.getWorkerAlias).mockImplementation(async worker => ({ value: worker === botId(20) ? '办公室 Windows' : null, version: '1' }));
  vi.mocked(bots.getBotDefaults).mockImplementation(async worker => {
    const selected = botWorkerDefaults(worker === botId(21) ? 21 : 20);
    return { ...botDefaults(), workerId: selected.workerId, configuration: selected.configuration, workers: [botWorkerDefaults(), botWorkerDefaults(21)] };
  });
  vi.mocked(bots.createBot).mockResolvedValue(botDefinition());
  vi.mocked(readApi.discoverWorkerModels).mockRejectedValue(new Error('Unavailable model metadata'));
  vi.mocked(readApi.browseWorkerDirectory).mockImplementation(async worker => ({
    type: 'result', protocol: readApi.WORKER_READONLY_PROTOCOL, ownerUserId: BOT_USER, workerId: worker,
    requestId: botId(50), connectionId: botId(51), capabilityGeneration: botId(52),
    result: { path: '/ordinary/directory', parentPath: '/', entries: [], nextCursor: null },
  }));
});

it('uses the alias for automatic selection, explicit options and directory context without changing the submitted Worker', async () => {
  renderWithLocale(<BotCreateForm unresolvedRequest={null} onUnresolvedRequestChange={vi.fn()} onClose={vi.fn()} onCreated={vi.fn()} />, { locale: 'en', taskCache: { viewerId: BOT_USER } });
  await waitFor(() => expect(screen.getByText(/办公室 Windows.*Machine 20.*Codex/)).toBeVisible());
  fireEvent.click(screen.getByText('Advanced settings')); await flush();
  const selector = screen.getByRole('combobox', { name: 'Worker' });
  expect(selector).toHaveValue('');
  expect(within(selector).getByRole('option', { name: 'Automatic · 办公室 Windows · Machine 20' })).toHaveValue('');
  expect(within(selector).getByRole('option', { name: '办公室 Windows · Machine 20' })).toHaveValue(botId(20));
  expect(within(selector).getByRole('option', { name: 'Machine 21' })).toHaveValue(botId(21));
  fireEvent.change(selector, { target: { value: botId(20) } }); await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
  expect(await screen.findByText('办公室 Windows · Machine 20')).toBeVisible();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Select this directory' })).toHaveAttribute('aria-disabled', 'false'));
  expect(readApi.browseWorkerDirectory).toHaveBeenCalledWith(botId(20), expect.anything(), expect.any(AbortSignal), expect.anything(), undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Select this directory' })); await flush();
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Helper' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create assistant' })); await flush();
  expect(bots.createBot).toHaveBeenCalledWith(expect.objectContaining({ overrides: { workerId: botId(20), cwd: '/ordinary/directory' } }), expect.any(AbortSignal), expect.anything());
});

it('keeps Bot details and running status on the same alias and ignores a different Worker observation', async () => {
  const bot = botDefinition(), worker = botWorkerDefaults();
  const props = { id: 'details', stale: false, opener: createRef<HTMLButtonElement>(), onClose: vi.fn() };
  const view = renderWithLocale(<><BotDetailsPanel {...props} bot={bot} worker={worker} observation={observation()} /><BotStatus bot={bot} observation={observation()} /></>, { locale: 'en', taskCache: { viewerId: BOT_USER } });
  await waitFor(() => expect(screen.getAllByText('办公室 Windows · Machine 20')).toHaveLength(2));
  expect(aliases.getWorkerAlias).toHaveBeenCalledTimes(1);
  view.rerender(<><BotDetailsPanel {...props} bot={bot} worker={botWorkerDefaults(21)} observation={observation()} /><BotStatus bot={bot} worker={botWorkerDefaults(21)} observation={observation()} /></>);
  expect(screen.queryByText(/Machine 21/)).toBeNull();
  expect(screen.getAllByText('办公室 Windows · Machine 20')).toHaveLength(2);
});

it('never shows the previous Bot alias when switching to another Worker with a delayed alias response', async () => {
  const pending = Promise.withResolvers<aliases.WorkerAlias>();
  vi.mocked(aliases.getWorkerAlias).mockImplementation(worker => worker === botId(20) ? pending.promise : Promise.resolve({ value: 'Laptop', version: '1' }));
  const first = botDefinition(), second = { ...botDefinition(2), workerId: botId(21) };
  const view = renderWithLocale(<BotStatus bot={first} observation={observation()} />, { locale: 'en', taskCache: { viewerId: BOT_USER } });
  await waitFor(() => expect(aliases.getWorkerAlias).toHaveBeenCalledTimes(1));
  view.rerender(<BotStatus bot={second} observation={observation(2, 21)} />);
  expect(await screen.findByText('Laptop · Machine 21')).toBeVisible();
  await act(async () => pending.resolve({ value: 'Old office', version: '1' }));
  expect(screen.getByText('Laptop · Machine 21')).toBeVisible();
  expect(screen.queryByText(/Old office/)).toBeNull();
});
