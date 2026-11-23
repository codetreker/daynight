import type { BotObservation } from '../../src/api/bot-observation';
import { BOT_TIME, botId } from './bots';

export const botObservation = (n = 1, patch: Partial<BotObservation> = {}): BotObservation => ({
  schemaVersion: 1, botId: botId(n), botVersion: '1', workerId: botId(20), machine: { id: 'machine-one', name: 'Office laptop' }, provider: 'codex',
  sessionId: botId(30 + n), testExecutionId: botId(40 + n), nativeSessionId: `native-${n}`, hostingGeneration: '1', executionGeneration: '1', connectionEpoch: '1',
  state: 'idle', reason: 'idle', observedAt: BOT_TIME, workerLastSeenAt: BOT_TIME, sessionLastSeenAt: BOT_TIME, freshUntil: '2026-11-04T12:00:30Z', currentTurnId: null,
  ...patch,
});
