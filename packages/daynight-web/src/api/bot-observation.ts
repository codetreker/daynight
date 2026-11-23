import { ApiError, assertResponsePrincipal, json, request, requestId } from './client';
import { id, malformed, nullableId, nullableTimestamp, record, string, timestamp } from './validation';
import type { WorkerReadAdmission } from './workers';

export type BotObservation = {
  readonly schemaVersion: 1;
  readonly botId: string; readonly botVersion: string; readonly workerId: string;
  readonly machine: { readonly id: string; readonly name: string } | null;
  readonly provider: 'codex' | 'claude' | 'copilot';
  readonly sessionId: string | null; readonly testExecutionId: string | null; readonly nativeSessionId: string | null;
  readonly hostingGeneration: string | null; readonly executionGeneration: string | null; readonly connectionEpoch: string | null;
  readonly state: 'offline' | 'connecting' | 'recovering' | 'idle' | 'working' | 'abnormal';
  readonly reason: string; readonly observedAt: string;
  readonly workerLastSeenAt: string | null; readonly sessionLastSeenAt: string | null; readonly freshUntil: string | null;
  readonly currentTurnId: string | null;
};

const fields = (value: unknown, keys: readonly string[]) => {
  const data = record(value);
  if (keys.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !keys.includes(key))) return malformed();
  return data;
};
const text = (value: unknown): string => {
  const result = string(value);
  return result.isWellFormed() && /[^\p{White_Space}]/u.test(result) && !result.includes('\0') ? result : malformed();
};
const decimal = (value: unknown): string => {
  const result = string(value);
  return /^[1-9]\d{0,18}$/.test(result) && BigInt(result) <= 9223372036854775807n ? result : malformed();
};
const nullableDecimal = (value: unknown) => value === null ? null : decimal(value);
const nullableText = (value: unknown) => value === null ? null : text(value);
const choice = <T extends string>(value: unknown, choices: readonly T[]): T => typeof value === 'string' && choices.includes(value as T) ? value as T : malformed();

export function parseBotObservation(value: unknown, expectedBotId: string): BotObservation {
  const data = fields(value, ['schemaVersion', 'botId', 'botVersion', 'workerId', 'machine', 'provider', 'sessionId', 'testExecutionId', 'nativeSessionId', 'hostingGeneration', 'executionGeneration', 'connectionEpoch', 'state', 'reason', 'observedAt', 'workerLastSeenAt', 'sessionLastSeenAt', 'freshUntil', 'currentTurnId']);
  if (data.schemaVersion !== 1 || id(data.botId) !== requestId(expectedBotId)) return malformed();
  const machine = data.machine === null ? null : fields(data.machine, ['id', 'name']);
  const result: BotObservation = {
    schemaVersion: 1, botId: id(data.botId), botVersion: decimal(data.botVersion), workerId: id(data.workerId),
    machine: machine === null ? null : { id: text(machine.id), name: text(machine.name) },
    provider: choice(data.provider, ['codex', 'claude', 'copilot']), sessionId: nullableId(data.sessionId), testExecutionId: nullableId(data.testExecutionId), nativeSessionId: nullableText(data.nativeSessionId),
    hostingGeneration: nullableDecimal(data.hostingGeneration), executionGeneration: nullableDecimal(data.executionGeneration), connectionEpoch: data.connectionEpoch === '0' ? '0' : nullableDecimal(data.connectionEpoch),
    state: choice(data.state, ['offline', 'connecting', 'recovering', 'idle', 'working', 'abnormal']), reason: text(data.reason), observedAt: timestamp(data.observedAt),
    workerLastSeenAt: nullableTimestamp(data.workerLastSeenAt), sessionLastSeenAt: nullableTimestamp(data.sessionLastSeenAt), freshUntil: nullableTimestamp(data.freshUntil), currentTurnId: nullableText(data.currentTurnId),
  };
  if ((result.sessionId === null) !== (result.testExecutionId === null) || result.currentTurnId !== null && result.state !== 'working') return malformed();
  if (result.state === 'offline' && result.freshUntil !== null) return malformed();
  if ((result.state === 'idle' || result.state === 'working') && (result.sessionId === null || result.nativeSessionId === null || result.executionGeneration === null || result.connectionEpoch === null)) return malformed();
  return result;
}

/** Read availability without granting or opening a Session. */
export async function getBotObservation(botId: string, signal: AbortSignal, admission: WorkerReadAdmission): Promise<BotObservation> {
  const target = requestId(botId), expected = requestId(admission.userId);
  const response = await request(`/api/v1/me/bots/${target}/observation`, signal, { headers: { Accept: 'application/json' } });
  assertResponsePrincipal(response, expected, admission.onPrincipalMismatch);
  return json(response, signal, value => {
    if (response.status !== 200) throw new ApiError('protocol', response.status);
    return parseBotObservation(value, target);
  });
}
