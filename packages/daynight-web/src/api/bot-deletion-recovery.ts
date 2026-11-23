import { ApiError, assertResponsePrincipal, json, request, requestId } from './client';
import { boolean, id, malformed, record, string, timestamp } from './validation';
import type { BotCleanupResult } from './bots';
import type { WorkerReadAdmission } from './workers';

export type BotDeletionRecovery = {
  readonly schemaVersion: 1; readonly botId: string; readonly version: string; readonly deletionId: string; readonly requestedVersion: string;
  readonly workerId: string; readonly hostingWorkerId: string; readonly requiresStopProof: boolean; readonly recoveryRequired: boolean;
  readonly originalBinding: null | { readonly sessionId: string; readonly testExecutionId: string; readonly executionGeneration: string; readonly controllerId: string; readonly controllerInstanceId: string };
  readonly workerCleanup: BotCleanupResult; readonly serverCleanup: BotCleanupResult;
  readonly decision: null | { readonly operationId: string; readonly requestedVersion: string; readonly actorUserId: string; readonly reason: string; readonly acknowledgedAt: string; readonly localDisposition: 'unverified' };
};
export type BotRecoveryInput = { readonly ifVersion: string; readonly deletionId: string; readonly operationId: string } & (
  { readonly action: 'accept_unverified'; readonly acknowledgeLocalUnverified: true; readonly reason: string } | { readonly action: 'retry_cleanup' }
);
const fields = (value: unknown, keys: readonly string[]) => {
  const data = record(value);
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) return malformed();
  return data;
};
const decimal = (value: unknown): string => {
  const parsed = string(value);
  return /^[1-9][0-9]{0,18}$/.test(parsed) && BigInt(parsed) <= 9_223_372_036_854_775_807n ? parsed : malformed();
};
const reason = (value: unknown): string => {
  const parsed = string(value);
  return parsed.isWellFormed() && !parsed.includes('\0') && /[^\p{White_Space}]/u.test(parsed) && [...parsed].length <= 1000 ? parsed : malformed();
};
const cleanup = (value: unknown): BotCleanupResult => {
  const data = fields(value, ['state', 'code']);
  if (data.state !== 'pending' && data.state !== 'completed' && data.state !== 'failed') return malformed();
  const code = data.code === null ? null : string(data.code);
  if ((data.state === 'failed') !== (code !== null) || code === '') return malformed();
  return { state: data.state, code };
};
const responsePrincipal = (response: Response, expected: string, admission: WorkerReadAdmission): void => {
  // Older servers return their router's plain 404 before identity middleware.
  // A supplied principal still has to match, including on unsupported routes.
  if (response.status === 404 && !response.headers.has('Daynight-User-ID')) throw new ApiError('server', 404, 'deletion_recovery_unsupported');
  assertResponsePrincipal(response, expected, admission.onPrincipalMismatch);
};
export function parseBotRecoveryInput(value: unknown): BotRecoveryInput {
  const data = record(value);
  fields(data, ['action', 'ifVersion', 'deletionId', 'operationId', ...(data.action === 'accept_unverified' ? ['acknowledgeLocalUnverified', 'reason'] : [])]);
  const identity = { ifVersion: decimal(data.ifVersion), deletionId: id(data.deletionId), operationId: id(data.operationId) };
  if (data.action === 'retry_cleanup') return { ...identity, action: data.action };
  if (data.action !== 'accept_unverified' || data.acknowledgeLocalUnverified !== true) return malformed();
  return { ...identity, action: data.action, acknowledgeLocalUnverified: true, reason: reason(data.reason) };
}
export function parseBotDeletionRecovery(value: unknown, botId: string, userId: string): BotDeletionRecovery {
  const data = fields(value, ['schemaVersion', 'botId', 'version', 'deletionId', 'requestedVersion', 'workerId', 'hostingWorkerId', 'requiresStopProof', 'recoveryRequired', 'originalBinding', 'workerCleanup', 'decision', 'serverCleanup']);
  if (data.schemaVersion !== 1 || id(data.botId) !== requestId(botId)) return malformed();
  const version = decimal(data.version), requestedVersion = decimal(data.requestedVersion);
  if (BigInt(version) <= BigInt(requestedVersion)) return malformed();
  let originalBinding: BotDeletionRecovery['originalBinding'] = null, decision: BotDeletionRecovery['decision'] = null;
  if (data.originalBinding !== null) {
    const binding = fields(data.originalBinding, ['sessionId', 'testExecutionId', 'executionGeneration', 'controllerId', 'controllerInstanceId']);
    originalBinding = { sessionId: id(binding.sessionId), testExecutionId: id(binding.testExecutionId), executionGeneration: decimal(binding.executionGeneration), controllerId: id(binding.controllerId), controllerInstanceId: id(binding.controllerInstanceId) };
  }
  if (data.decision !== null) {
    const value = fields(data.decision, ['operationId', 'requestedVersion', 'actorUserId', 'reason', 'acknowledgedAt', 'localDisposition']);
    if (value.localDisposition !== 'unverified' || id(value.actorUserId) !== requestId(userId)) return malformed();
    decision = { operationId: id(value.operationId), requestedVersion: decimal(value.requestedVersion), actorUserId: id(value.actorUserId), reason: reason(value.reason), acknowledgedAt: timestamp(value.acknowledgedAt), localDisposition: 'unverified' };
    if (BigInt(decision.requestedVersion) >= BigInt(version) || BigInt(decision.requestedVersion) <= BigInt(requestedVersion)) return malformed();
  }
  const requiresStopProof = boolean(data.requiresStopProof), recoveryRequired = boolean(data.recoveryRequired), workerCleanup = cleanup(data.workerCleanup), serverCleanup = cleanup(data.serverCleanup);
  if (requiresStopProof !== (originalBinding !== null) || recoveryRequired !== (decision === null && workerCleanup.state === 'failed' && workerCleanup.code === 'execution_evidence_missing' && serverCleanup.state !== 'completed')) return malformed();
  if (decision !== null && (workerCleanup.state !== 'failed' || workerCleanup.code !== 'execution_evidence_missing')) return malformed();
  return { schemaVersion: 1, botId: id(data.botId), version, deletionId: id(data.deletionId), requestedVersion, workerId: id(data.workerId), hostingWorkerId: id(data.hostingWorkerId), requiresStopProof, recoveryRequired, originalBinding, workerCleanup, serverCleanup, decision };
}
export async function getBotDeletionRecovery(botId: string, signal: AbortSignal, admission: WorkerReadAdmission, onDispatch?: () => void): Promise<BotDeletionRecovery> {
  const target = requestId(botId), expected = requestId(admission.userId);
  const response = await request(`/api/v1/me/bots/${target}/deletion-recovery`, signal, { headers: { Accept: 'application/json' } }, onDispatch);
  responsePrincipal(response, expected, admission);
  return json(response, signal, value => { if (response.status !== 200) throw new ApiError('protocol', response.status); return parseBotDeletionRecovery(value, target, expected); });
}
export async function listBotDeletionRecoveries(cursor: string | null, signal: AbortSignal, admission: WorkerReadAdmission): Promise<{ readonly items: readonly BotDeletionRecovery[]; readonly nextCursor: string | null }> {
  const parameters = new URLSearchParams({ limit: '100' });
  if (cursor !== null) {
    if (!cursor || cursor.length > 4096 || /\p{Cc}/u.test(cursor)) throw new ApiError('protocol');
    parameters.set('cursor', cursor);
  }
  const expected = requestId(admission.userId);
  const response = await request(`/api/v1/me/bot-deletion-recoveries?${parameters}`, signal, { headers: { Accept: 'application/json' } });
  responsePrincipal(response, expected, admission);
  return json(response, signal, value => {
    if (response.status !== 200) throw new ApiError('protocol', response.status);
    const data = fields(value, ['items', 'nextCursor']);
    if (!Array.isArray(data.items) || data.items.length > 100) return malformed();
    const items = data.items.map(value => parseBotDeletionRecovery(value, id(record(value).botId), expected));
    if (new Set(items.map(value => value.botId)).size !== items.length) return malformed();
    if (items.some(value => value.decision === null && value.workerCleanup.code !== 'execution_evidence_missing')) return malformed();
    const nextCursor = data.nextCursor === null ? null : string(data.nextCursor);
    if (nextCursor !== null && (!nextCursor || nextCursor.length > 4096 || /\p{Cc}/u.test(nextCursor))) return malformed();
    return { items, nextCursor };
  });
}
export class BotRecoveryUnknown extends Error {
  constructor(readonly botId: string, readonly input: BotRecoveryInput, cause: unknown) { super('The assistant deletion recovery outcome is unknown.', { cause }); }
}
export async function submitBotDeletionRecovery(botId: string, input: BotRecoveryInput, signal: AbortSignal, admission: WorkerReadAdmission, onDispatch?: () => void): Promise<BotDeletionRecovery> {
  const target = requestId(botId), expected = requestId(admission.userId), original = Object.freeze(parseBotRecoveryInput(input));
  let dispatched = false;
  try {
    const response = await request(`/api/v1/me/bots/${target}/deletion-recovery`, signal, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(original) }, () => { dispatched = true; onDispatch?.(); });
    responsePrincipal(response, expected, admission);
    return await json(response, signal, value => {
      if (response.status !== 200) throw new ApiError('protocol', response.status);
      const parsed = parseBotDeletionRecovery(value, target, expected);
      if (parsed.deletionId !== original.deletionId || parsed.decision?.operationId !== original.operationId) return malformed();
      if (BigInt(parsed.version) <= BigInt(original.ifVersion)) return malformed();
      if (original.action === 'accept_unverified' && (parsed.decision.requestedVersion !== original.ifVersion || parsed.decision.reason !== original.reason)) return malformed();
      return parsed;
    });
  } catch (error) {
    if (dispatched && !(error instanceof ApiError && error.kind === 'server' && error.status !== null && error.status >= 400 && error.status < 500)) throw new BotRecoveryUnknown(target, original, error);
    throw error;
  }
}
