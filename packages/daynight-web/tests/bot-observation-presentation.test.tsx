import { createRef } from 'react';
import { fireEvent, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { BotObservation } from '../src/api/bot-observation';
import { BotStatus } from '../src/features/bots/BotStatus';
import { BotConversationHeader, type BotConversationTarget } from '../src/features/bots/BotConversationHeader';
import { BotDetailsPanel } from '../src/features/bots/BotDetailsPanel';
import type { BotObservationRead } from '../src/features/bots/useBotObservations';
import type { SessionHeaderSlot } from '../src/features/task-agent-session/session-presentation-slots';
import { renderWithLocale } from './helpers/renderWithLocale';
import { BOT_TIME, botDefinition, botId, botWorkerDefaults } from './helpers/bots';

const observation = (change: Partial<BotObservation> = {}): BotObservationRead => ({
  value: { schemaVersion: 1, botId: botId(), botVersion: '1', workerId: botId(22), machine: { id: 'original-machine', name: 'Original workstation' }, provider: 'codex', sessionId: botId(30), testExecutionId: botId(31), nativeSessionId: 'native-original', hostingGeneration: '1', executionGeneration: '1', connectionEpoch: '1', state: 'idle', reason: 'idle', observedAt: BOT_TIME, workerLastSeenAt: BOT_TIME, sessionLastSeenAt: BOT_TIME, freshUntil: '2026-11-04T12:00:30Z', currentTurnId: null, ...change },
  stale: false, busy: false, error: null, refresh: vi.fn(),
});
const target = (read: BotObservationRead): BotConversationTarget => ({ bot: botDefinition(), worker: botWorkerDefaults(), stale: false, observation: read, name: 'Original assistant', detailsId: 'details', detailsOpen: false, detailsOpener: createRef(), onDetails: vi.fn(), follow: vi.fn() });
const session: SessionHeaderSlot = { snapshot: null, startupReport: null, active: true, current: true, available: true, readOnly: false, runtimeReady: true, authPaused: false, status: 'ready', fullscreen: false, displayMode: 'standard', statusDescriptionId: 'session-status', provider: <span>Codex</span>, activity: <span>Unrelated Session activity</span>, display: null, focus: null, refresh: null };
const details = (read: BotObservationRead) => <BotDetailsPanel id="details" bot={botDefinition()} worker={botWorkerDefaults()} stale={false} observation={read} opener={createRef()} onClose={vi.fn()} />;

it.each([
  ['offline', 'Offline', '离线'], ['connecting', 'Connecting', '连接中'], ['recovering', 'Recovering', '恢复中'],
  ['idle', 'Online · idle', '在线 · 空闲'], ['working', 'Working', '工作中'], ['abnormal', 'Abnormal', '异常'],
] as const)('uses the same %s observation in the list, mounted header and details', (state, english, chinese) => {
  const read = observation({ state });
  const view = renderWithLocale(<><div data-testid="list"><BotStatus bot={botDefinition()} observation={read} compact /></div><header><BotConversationHeader target={target(read)} session={session} /></header>{details(read)}</>, { locale: 'en' });
  expect(screen.getAllByText(english)).toHaveLength(3);
  expect(screen.queryByText('Unrelated Session activity')).toBeNull();
  expect(screen.queryByText('Connected')).toBeNull();
  expect(within(screen.getByTestId('list')).getByText('Original workstation')).toBeVisible();
  view.setLocale('zh-CN');
  expect(screen.getAllByText(chinese)).toHaveLength(3);
});

it('withdraws live status while retaining dated machine and Session facts and a read retry', () => {
  const read = { ...observation({ state: 'working', reason: 'working' }), stale: true, error: new Error('offline') };
  renderWithLocale(<><BotStatus bot={botDefinition()} observation={read} />{details(read)}</>, { locale: 'en' });
  expect(screen.getAllByText('Observation out of date')).toHaveLength(2);
  expect(screen.getAllByText('Working')).toHaveLength(1);
  expect(screen.getByText('Last observed status')).toBeVisible();
  expect(screen.getByText('native-original')).toBeVisible();
  expect(screen.getByText('Could not read this assistant’s status.')).toBeVisible();
  expect(screen.getAllByText('Original workstation')).toHaveLength(2);
  expect(document.querySelectorAll(`time[datetime="${BOT_TIME}"]`).length).toBeGreaterThanOrEqual(3);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  expect(read.refresh).toHaveBeenCalledOnce();
});

it('does not infer availability from startup readiness, another Worker, or another Bot observation', () => {
  renderWithLocale(<BotStatus bot={{ ...botDefinition(), startupResult: { state: 'ready', code: null } }} worker={botWorkerDefaults()} stale={false} observation={observation({ botId: botId(2) })} />, { locale: 'en' });
  expect(screen.getByText('Status unknown')).toBeVisible();
  expect(screen.getByText('Machine unknown')).toBeVisible();
  expect(screen.queryByText('Original workstation')).toBeNull();
});

it('keeps first-start native identity explicitly unknown', () => {
  renderWithLocale(details(observation({ state: 'connecting', reason: 'native_session_pending', nativeSessionId: null })), { locale: 'en' });
  expect(screen.getByText('Waiting for the first native Session ID.')).toBeVisible();
  const native = screen.getByText('Native Session ID').closest('div')!;
  expect(within(native).getByText('Unknown')).toBeVisible();
  expect(screen.getByText(/first native Session ID will appear/)).toBeVisible();
});

it.each([
  ['worker_heartbeat_expired', 'offline', 'daynight worker run'],
  ['provider_unavailable', 'abnormal', /selected Provider is installed and signed in/],
  ['native_session_missing', 'abnormal', /restore the original Session record/],
  ['hosting_identity_mismatch', 'abnormal', /whether the original execution has stopped/],
  ['connection_reset', 'recovering', /Worker connection and synchronization/],
  ['directory_missing', 'abnormal', /Restore access to the assistant’s working directory/],
  ['future_startup_error', 'abnormal', /Check unknown operation results/],
] as const)('explains %s with a machine-specific next step and original reason code', (reason, state, action) => {
  renderWithLocale(details(observation({ reason, state })), { locale: 'en' });
  expect(screen.getByText(action)).toBeVisible();
  expect(screen.getAllByText(reason).some(node => node.tagName === 'CODE')).toBe(true);
  expect(screen.getByText('Original workstation')).toBeVisible();
  expect(screen.getByText(botId(22))).toBeVisible();
});
