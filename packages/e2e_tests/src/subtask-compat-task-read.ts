import { setTimeout as delay } from 'node:timers/promises';
import { CommandFailure, type CommandResult } from './command.ts';

export type CompatTaskObservation = {
  schemaVersion: 1;
  observation: 'observed' | 'unavailable' | 'unsupported';
  registration: 'registered' | 'not_registered' | 'not_applicable' | 'unknown';
  reason: string;
  claimId: string | null;
  error: { code: string; message: string } | null;
  observedAt: string | null;
  lastSeenAt: string | null;
  freshUntil: string | null;
};
export type CompatTask = {
  id: string; projectId: string; version: number; status: string;
  properties: { worker?: { workerId: string; claimId: string; state: string; [key: string]: unknown }; [key: string]: unknown };
  session: CompatTaskObservation;
};
export type CompatTaskReadInput = {
  command: (args: string[]) => Promise<CommandResult>;
  projectId: string; taskId: string; workerId?: string; claimId?: string;
  timeoutMs?: number; intervalMs?: number;
};
export type PartialTaskObservation = Pick<CompatTaskObservation, 'reason' | 'error' | 'observedAt' | 'lastSeenAt' | 'freshUntil'> & { stderr: string };

export class CompatTaskReadError extends Error {
  readonly observations: readonly PartialTaskObservation[];
  constructor(message: string, observations: readonly PartialTaskObservation[], cause?: unknown) {
    super(`${message}${observations.length ? `\nPartial Session observations: ${JSON.stringify(observations)}` : ''}`, { cause });
    this.name = 'CompatTaskReadError';
    this.observations = observations;
  }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const nullableText = (value: unknown): boolean => value === null || typeof value === 'string';
const oneOf = (value: unknown, choices: readonly string[]): boolean => typeof value === 'string' && choices.includes(value);
const nullableChoice = (value: unknown, choices: readonly string[]): boolean => value === null || oneOf(value, choices);
const timestamp = (value: unknown): value is string | null => value === null || typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));

// Each command must have its own bounded lifetime and settle only after its
// owned process has stopped. The retry deadline never abandons a command.
export async function readCompatTask<T extends CompatTask = CompatTask>(input: CompatTaskReadInput): Promise<T> {
  const timeoutMs = input.timeoutMs ?? 10_000, intervalMs = input.intervalMs ?? 250;
  if (!nonempty(input.projectId) || !nonempty(input.taskId) || input.workerId !== undefined && !nonempty(input.workerId)
    || input.claimId !== undefined && (!nonempty(input.claimId) || !nonempty(input.workerId))
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('Invalid Task read identity or timing.');
  }
  const observations: PartialTaskObservation[] = [];
  const deadline = performance.now() + timeoutMs;
  let originalWorker: { workerId: string; claimId: string } | undefined;
  const fail = (message: string, cause?: unknown): never => { throw new CompatTaskReadError(message, [...observations], cause); };
  for (;;) {
    let result: CommandResult;
    try {
      result = await input.command(['task', 'show', input.taskId, '--project', input.projectId, '--json']);
    } catch (error) {
      if (error instanceof CommandFailure && error.result.exitCode === 3) result = error.result;
      else if (observations.length) return fail('Task read failed after partial Session observations.', error);
      else throw error;
    }
    if (result.exitCode !== 0 && result.exitCode !== 3) {
      const error = new CommandFailure('task show', result);
      if (observations.length) return fail('Task read failed after partial Session observations.', error);
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(result.stdout); } catch (error) { return fail('Task read returned malformed JSON.', error); }
    if (!record(value)) return fail('Task read returned malformed Task data.');
    const session = value.session;
    if (!record(session) || session.schemaVersion !== 1 || !oneOf(session.observation, ['observed', 'unavailable', 'unsupported'])
      || !oneOf(session.registration, ['registered', 'not_registered', 'not_applicable', 'unknown'])
      || !nonempty(session.reason) || !(session.claimId === null || nonempty(session.claimId))
      || !(session.sessionId === null || nonempty(session.sessionId)) || !nullableText(session.nativeSessionId)
      || ![session.executionGeneration, session.connectionEpoch].every(value => value === null || typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))
      || !nullableChoice(session.agentControlMode, ['web', 'herdr']) || !nullableChoice(session.contentKind, ['native_timeline', 'terminal_recording'])
      || !nullableText(session.provider) || !nullableChoice(session.indicator, ['working', 'notice', 'warning'])
      || !nullableChoice(session.activity, ['initializing', 'idle', 'working', 'waiting_input', 'stopped', 'unknown'])
      || !nullableChoice(session.connectionState, ['connected', 'disconnected', 'synchronizing'])
      || !nullableChoice(session.lifecycle, ['active', 'draining', 'archived']) || !nullableText(session.currentTurnId)
      || !(session.needsAttention === null || typeof session.needsAttention === 'boolean')
      || !record(session.send) || !(session.send.allowed === null || typeof session.send.allowed === 'boolean')
      || !nullableChoice(session.send.mode, ['start', 'steer']) || !nonempty(session.send.reason)
      || !timestamp(session.observedAt) || !timestamp(session.lastSeenAt) || !timestamp(session.freshUntil)
      || !(session.error === null || record(session.error) && nonempty(session.error.code) && typeof session.error.message === 'string')) return fail('Task read returned malformed Session observation.');
    const observation = session as CompatTaskObservation;
    if (result.exitCode === 3) observations.push({ reason: observation.reason, error: observation.error, observedAt: observation.observedAt, lastSeenAt: observation.lastSeenAt, freshUntil: observation.freshUntil, stderr: result.stderr });
    if (value.id !== input.taskId || value.projectId !== input.projectId) return fail('Task read Project or Task identity mismatch.');
    if (!Number.isSafeInteger(value.version) || (value.version as number) < 1 || !nonempty(value.status) || !record(value.properties)) return fail('Task read returned malformed Task data.');
    const worker = value.properties.worker;
    if (worker !== undefined && (!record(worker) || !nonempty(worker.workerId) || !nonempty(worker.claimId) || !nonempty(worker.state))) return fail('Task read returned malformed Worker identity.');
    if (worker !== undefined && record(worker)) {
      const workerId = worker.workerId as string, claimId = worker.claimId as string;
      if (input.workerId !== undefined && workerId !== input.workerId || input.claimId !== undefined && claimId !== input.claimId
        || originalWorker !== undefined && (workerId !== originalWorker.workerId || claimId !== originalWorker.claimId)) return fail('Task read Worker or claim identity mismatch.');
      originalWorker ??= { workerId, claimId };
    } else if (input.claimId !== undefined || originalWorker !== undefined) return fail('Task read Worker or claim identity mismatch.');
    if (observation.registration === 'registered' && observation.claimId === null) return fail('Task read Session claim identity mismatch.');
    if (observation.claimId !== null && (input.claimId !== undefined && observation.claimId !== input.claimId
      || record(worker) && observation.claimId !== worker.claimId)) return fail('Task read Session claim identity mismatch.');
    if (result.exitCode === 0) {
      if (observation.observation !== 'observed' || observation.error !== null) return fail('Task read exit 0 did not contain a complete Session observation.');
      if (performance.now() >= deadline) return fail('Task read deadline exceeded.');
      return value as T;
    }
    if (observation.observation !== 'unavailable' || !['execution_changed', 'observation_unavailable'].includes(observation.reason)
      || observation.error?.code !== observation.reason) return fail('Task read returned a non-recoverable partial Session observation.');
    const remaining = deadline - performance.now();
    if (remaining <= 0) return fail('Task read deadline exceeded.');
    await delay(Math.min(intervalMs, remaining));
    if (performance.now() >= deadline) return fail('Task read deadline exceeded.');
  }
}
