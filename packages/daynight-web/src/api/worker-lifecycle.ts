import { assertResponsePrincipal, json, request } from './client';
import { boolean, id, malformed, record, timestamp } from './parse';
import { parseConfigurationRevision } from './worker-configuration';
import type { WorkerReadAdmission } from './workers';

export const WORKER_LIFECYCLE_HEADER = 'X-Daynight-Worker-Lifecycle';
type Desired = 'enabled' | 'disabled';
type Admission = 'open' | 'closed';
export type LifecycleDiagnostic = 'identity_mismatch' | 'authority_unavailable' | 'persistence_failed' | 'inventory_incomplete' | 'stop_timeout' | 'stop_unknown' | 'save_failed' | 'upload_failed' | 'native_unrecoverable' | 'ownership_changed' | 'independent_blocker' | 'unsupported_provider' | 'resume_interrupted';
export type LifecycleResourceObservation = {
  readonly resourceId: string; readonly ownerKind: 'task' | 'bot' | 'assistant' | 'probe' | 'repository' | 'configuration' | 'controller';
  readonly projectId: string | null; readonly taskId: string | null; readonly botId: string | null; readonly executionId: string | null; readonly sessionId: string | null;
  readonly executionGeneration: string | null; readonly stage: 'reserved' | 'running' | 'stopping' | 'stopped' | 'unknown';
  readonly stop: 'pending' | 'confirmed' | 'unknown'; readonly save: 'pending' | 'durable' | 'failed'; readonly errorCode: LifecycleDiagnostic | null;
};
export type LifecycleRecoveryObservation = { readonly resourceId: string; readonly recoverability: 'unknown' | 'eligible' | 'blocked'; readonly reasonCode: LifecycleDiagnostic | null };
export type LifecycleObservation = {
  readonly phase: 'accepting' | 'disabling' | 'disabled' | 'blocked' | 'resuming'; readonly stop: 'not_started' | 'stopping' | 'confirmed' | 'unknown';
  readonly save: 'pending' | 'durable' | 'failed'; readonly sync: 'pending' | 'complete' | 'failed'; readonly inventoryComplete: boolean; readonly detailsComplete: boolean;
  readonly inventoryRevision: string; readonly inventoryDigest: string; readonly resourceCount: number | null; readonly stoppedCount: number | null;
  readonly pendingCount: number | null; readonly blockedCount: number | null; readonly resources: readonly LifecycleResourceObservation[];
  readonly recovery: readonly LifecycleRecoveryObservation[]; readonly errorCode: LifecycleDiagnostic | null; readonly receivedAt: string; readonly freshUntil: string;
};
export type LifecycleObservedEnvelope = {
  readonly protocolVersion: 1; readonly instanceId: string; readonly intentVersion: string; readonly operationId: string | null;
  readonly localEpoch: string; readonly scopeGeneration: string; readonly reportSequence: string; readonly observation: LifecycleObservation;
};
export type LifecycleResource = {
  readonly protocolVersion: 1; readonly workerId: string; readonly intentVersion: string; readonly desired: Desired; readonly admission: Admission;
  readonly operationId: string | null; readonly instance: { readonly instanceId: string } | null;
  readonly capability: 'supported' | 'unsupported'; readonly observation: LifecycleObservedEnvelope | null; readonly observedAt: string;
};
export type LifecycleIntentRequest = {
  readonly protocolVersion: 1; readonly operationId: string; readonly expectedVersion: string; readonly source: 'web';
} & ({ readonly action: 'disable'; readonly localEpoch: null; readonly originOperationId: null }
  | { readonly action: 'resume'; readonly localEpoch: string; readonly instanceId: string });
export type LifecycleIntentReceipt = {
  readonly protocolVersion: 1; readonly workerId: string; readonly operationId: string; readonly action: 'disable' | 'resume'; readonly intentVersion: string;
  readonly desired: Desired; readonly admission: 'closed'; readonly state: 'accepted' | 'applied' | 'blocked' | 'superseded'; readonly errorCode: string | null; readonly observedAt: string;
};
export type LifecycleActivationReceipt = {
  readonly protocolVersion: 1; readonly workerId: string; readonly operationId: string; readonly action: 'resume' | 'bootstrap' | 'reconnect'; readonly instanceId: string;
  readonly intentVersion: string; readonly localEpoch: string; readonly scopeGeneration: string; readonly admission: 'open'; readonly observedAt: string;
};
export type LifecycleInstanceReceipt = {
  readonly protocolVersion: 1; readonly workerId: string; readonly instanceId: string; readonly intentVersion: string; readonly desired: Desired;
  readonly admission: 'closed'; readonly operationId: string; readonly reconnectAllowed: boolean; readonly observedAt: string;
};
export type LifecycleResolutionReceipt = {
  readonly protocolVersion: 1; readonly workerId: string; readonly operationId: string; readonly requestKind: 'instance' | 'intent' | 'activation';
  readonly requestHash: string; readonly outcome: 'not_committed'; readonly observedAt: string;
};
export type LifecycleOperationResult =
  | { readonly kind: 'intent'; readonly receipt: LifecycleIntentReceipt; readonly activation: LifecycleActivationReceipt | null; readonly activationOutcome: 'not_started' | 'committed' | 'not_committed' }
  | { readonly kind: 'instance'; readonly receipt: LifecycleInstanceReceipt }
  | { readonly kind: 'activation'; readonly receipt: LifecycleActivationReceipt }
  | { readonly kind: 'not_committed'; readonly receipt: LifecycleResolutionReceipt };

const fields = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const data = record(value);
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) return malformed();
  return data;
};
const choice = <T extends string>(value: unknown, values: readonly T[]): T => typeof value === 'string' && values.includes(value as T) ? value as T : malformed();
const uuid = (value: unknown): string => { const result = id(value); return result === value && result !== '00000000-0000-0000-0000-000000000000' ? result : malformed(); };
const nullable = <T,>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value);
const revision = (value: unknown): string => parseConfigurationRevision(value);
const version = (value: unknown): 1 => value === 1 ? 1 : malformed();
const desired = (value: unknown): Desired => choice(value, ['enabled', 'disabled']);
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : malformed();
const hash = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : malformed();
const diagnostic = (value: unknown): LifecycleDiagnostic | null => nullable(value, item => choice(item, ['identity_mismatch', 'authority_unavailable', 'persistence_failed', 'inventory_incomplete', 'stop_timeout', 'stop_unknown', 'save_failed', 'upload_failed', 'native_unrecoverable', 'ownership_changed', 'independent_blocker', 'unsupported_provider', 'resume_interrupted']));
const code = (value: unknown): string | null => nullable(value, item => typeof item === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(item) ? item : malformed());
const list = <T extends { readonly resourceId: string }>(value: unknown, parse: (value: unknown) => T): readonly T[] => {
  if (!Array.isArray(value) || value.length > 512) return malformed();
  const result = value.map(parse);
  if (result.some((item, index) => index > 0 && result[index - 1]!.resourceId >= item.resourceId)) return malformed();
  return result;
};
const resourceObservation = (value: unknown): LifecycleResourceObservation => {
  const data = fields(value, ['resourceId', 'ownerKind', 'projectId', 'taskId', 'botId', 'executionId', 'sessionId', 'executionGeneration', 'stage', 'stop', 'save', 'errorCode']);
  return { resourceId: uuid(data.resourceId), ownerKind: choice(data.ownerKind, ['task', 'bot', 'assistant', 'probe', 'repository', 'configuration', 'controller']),
    projectId: nullable(data.projectId, uuid), taskId: nullable(data.taskId, uuid), botId: nullable(data.botId, uuid), executionId: nullable(data.executionId, uuid), sessionId: nullable(data.sessionId, uuid),
    executionGeneration: nullable(data.executionGeneration, revision), stage: choice(data.stage, ['reserved', 'running', 'stopping', 'stopped', 'unknown']),
    stop: choice(data.stop, ['pending', 'confirmed', 'unknown']), save: choice(data.save, ['pending', 'durable', 'failed']), errorCode: diagnostic(data.errorCode) };
};
export const parseLifecycleObservedEnvelope = (value: unknown): LifecycleObservedEnvelope => {
  const data = fields(value, ['protocolVersion', 'instanceId', 'intentVersion', 'operationId', 'localEpoch', 'scopeGeneration', 'reportSequence', 'observation']);
  const raw = fields(data.observation, ['phase', 'stop', 'save', 'sync', 'inventoryComplete', 'detailsComplete', 'inventoryRevision', 'inventoryDigest', 'resourceCount', 'stoppedCount', 'pendingCount', 'blockedCount', 'resources', 'recovery', 'errorCode', 'receivedAt', 'freshUntil']);
  const observation: LifecycleObservation = { phase: choice(raw.phase, ['accepting', 'disabling', 'disabled', 'blocked', 'resuming']), stop: choice(raw.stop, ['not_started', 'stopping', 'confirmed', 'unknown']),
    save: choice(raw.save, ['pending', 'durable', 'failed']), sync: choice(raw.sync, ['pending', 'complete', 'failed']), inventoryComplete: boolean(raw.inventoryComplete), detailsComplete: boolean(raw.detailsComplete),
    inventoryRevision: revision(raw.inventoryRevision), inventoryDigest: hash(raw.inventoryDigest), resourceCount: nullable(raw.resourceCount, count), stoppedCount: nullable(raw.stoppedCount, count),
    pendingCount: nullable(raw.pendingCount, count), blockedCount: nullable(raw.blockedCount, count), resources: list(raw.resources, resourceObservation), recovery: list(raw.recovery, value => {
      const recovery = fields(value, ['resourceId', 'recoverability', 'reasonCode']);
      return { resourceId: uuid(recovery.resourceId), recoverability: choice(recovery.recoverability, ['unknown', 'eligible', 'blocked']), reasonCode: diagnostic(recovery.reasonCode) };
    }), errorCode: diagnostic(raw.errorCode), receivedAt: timestamp(raw.receivedAt), freshUntil: timestamp(raw.freshUntil) };
  const o = observation;
  if (Date.parse(o.freshUntil) <= Date.parse(o.receivedAt) || o.inventoryComplete && (o.resourceCount === null || [o.stoppedCount, o.pendingCount, o.blockedCount].some(n => n === null || n > o.resourceCount!))
    || o.stop === 'confirmed' && (!o.inventoryComplete || o.resourceCount !== o.stoppedCount || o.pendingCount !== 0 || o.blockedCount !== 0 || o.resources.some(r => r.stop !== 'confirmed' || r.stage !== 'stopped'))
    || o.save === 'durable' && (!o.inventoryComplete || o.resources.some(r => r.save !== 'durable'))
    || o.phase === 'disabled' && (o.stop !== 'confirmed' || o.save !== 'durable') || o.detailsComplete && (o.resourceCount === null || o.resources.length !== o.resourceCount)
    || new TextEncoder().encode(JSON.stringify(value)).length > 256 * 1024 + 128) return malformed();
  return { protocolVersion: version(data.protocolVersion), instanceId: uuid(data.instanceId), intentVersion: revision(data.intentVersion), operationId: nullable(data.operationId, uuid),
    localEpoch: revision(data.localEpoch), scopeGeneration: revision(data.scopeGeneration), reportSequence: revision(data.reportSequence), observation };
};
export const parseLifecycleResource = (value: unknown, workerId?: string): LifecycleResource => {
  const data = fields(value, ['protocolVersion', 'workerId', 'intentVersion', 'desired', 'admission', 'operationId', 'instance', 'capability', 'observation', 'observedAt']);
  const result: LifecycleResource = { protocolVersion: version(data.protocolVersion), workerId: uuid(data.workerId), intentVersion: revision(data.intentVersion), desired: desired(data.desired), admission: choice(data.admission, ['open', 'closed']),
    operationId: nullable(data.operationId, uuid), instance: nullable(data.instance, value => { const instance = fields(value, ['instanceId']); return { instanceId: uuid(instance.instanceId) }; }),
    capability: choice(data.capability, ['supported', 'unsupported']), observation: nullable(data.observation, parseLifecycleObservedEnvelope), observedAt: timestamp(data.observedAt) };
  if (workerId !== undefined && result.workerId !== uuid(workerId) || result.desired === 'disabled' && result.admission !== 'closed') return malformed();
  return result;
};
export const parseLifecycleIntentRequest = (value: unknown): LifecycleIntentRequest => {
  const data = record(value), action = choice(data.action, ['disable', 'resume']);
  fields(data, ['protocolVersion', 'operationId', 'expectedVersion', 'source', 'action', 'localEpoch', action === 'disable' ? 'originOperationId' : 'instanceId']);
  const common = { protocolVersion: version(data.protocolVersion), operationId: uuid(data.operationId), expectedVersion: revision(data.expectedVersion), source: choice(data.source, ['web']) };
  if (action === 'disable') {
    if (data.localEpoch !== null || data.originOperationId !== null) return malformed();
    return { ...common, action, localEpoch: null, originOperationId: null };
  }
  return { ...common, action, localEpoch: revision(data.localEpoch), instanceId: uuid(data.instanceId) };
};
const baseReceipt = (data: Record<string, unknown>) => ({ protocolVersion: version(data.protocolVersion), workerId: uuid(data.workerId), operationId: uuid(data.operationId), observedAt: timestamp(data.observedAt) });
export const parseLifecycleIntentReceipt = (value: unknown): LifecycleIntentReceipt => {
  const data = fields(value, ['protocolVersion', 'workerId', 'operationId', 'action', 'intentVersion', 'desired', 'admission', 'state', 'errorCode', 'observedAt']);
  const result: LifecycleIntentReceipt = { ...baseReceipt(data), action: choice(data.action, ['disable', 'resume']), intentVersion: revision(data.intentVersion), desired: desired(data.desired), admission: choice(data.admission, ['closed']), state: choice(data.state, ['accepted', 'applied', 'blocked', 'superseded']), errorCode: code(data.errorCode) };
  if ((result.action === 'disable') !== (result.desired === 'disabled')) return malformed();
  return result;
};
const activationReceipt = (value: unknown): LifecycleActivationReceipt => {
  const data = fields(value, ['protocolVersion', 'workerId', 'operationId', 'action', 'instanceId', 'intentVersion', 'localEpoch', 'scopeGeneration', 'admission', 'observedAt']);
  return { ...baseReceipt(data), action: choice(data.action, ['resume', 'bootstrap', 'reconnect']), instanceId: uuid(data.instanceId), intentVersion: revision(data.intentVersion), localEpoch: revision(data.localEpoch), scopeGeneration: revision(data.scopeGeneration), admission: choice(data.admission, ['open']) };
};
export const parseLifecycleOperationResult = (value: unknown, workerId?: string, operationId?: string): LifecycleOperationResult => {
  const data = record(value), kind = choice(data.kind, ['intent', 'instance', 'activation', 'not_committed']);
  fields(data, kind === 'intent' ? ['kind', 'receipt', 'activation', 'activationOutcome'] : ['kind', 'receipt']);
  let result: LifecycleOperationResult;
  if (kind === 'intent') {
    const receipt = parseLifecycleIntentReceipt(data.receipt), activation = nullable(data.activation, activationReceipt), activationOutcome = choice(data.activationOutcome, ['not_started', 'committed', 'not_committed']);
    if ((activation !== null) !== (activationOutcome === 'committed') || activation !== null && (receipt.action !== 'resume' || activation.action !== 'resume' || activation.workerId !== receipt.workerId || activation.operationId !== receipt.operationId || activation.intentVersion !== receipt.intentVersion)) return malformed();
    result = { kind, receipt, activation, activationOutcome };
  } else if (kind === 'activation') result = { kind, receipt: activationReceipt(data.receipt) };
  else if (kind === 'instance') {
    const raw = fields(data.receipt, ['protocolVersion', 'workerId', 'instanceId', 'intentVersion', 'desired', 'admission', 'operationId', 'reconnectAllowed', 'observedAt']);
    result = { kind, receipt: { ...baseReceipt(raw), instanceId: uuid(raw.instanceId), intentVersion: revision(raw.intentVersion), desired: desired(raw.desired), admission: choice(raw.admission, ['closed']), reconnectAllowed: boolean(raw.reconnectAllowed) } };
  } else {
    const raw = fields(data.receipt, ['protocolVersion', 'workerId', 'operationId', 'requestKind', 'requestHash', 'outcome', 'observedAt']);
    result = { kind, receipt: { ...baseReceipt(raw), requestKind: choice(raw.requestKind, ['instance', 'intent', 'activation']), requestHash: hash(raw.requestHash), outcome: choice(raw.outcome, ['not_committed']) } };
  }
  if (workerId !== undefined && result.receipt.workerId !== uuid(workerId) || operationId !== undefined && result.receipt.operationId !== uuid(operationId)) return malformed();
  return result;
};

const lifecycleRequest = async <T,>(workerId: string, suffix: string, signal: AbortSignal, admission: WorkerReadAdmission, status: number, parse: (value: unknown) => T, input?: unknown, onDispatch?: () => void): Promise<T> => {
  uuid(workerId); uuid(admission.userId);
  const response = await request(`/api/v1/me/workers/${workerId}/lifecycle${suffix}`, signal, { method: input === undefined ? 'GET' : 'POST',
    headers: { Accept: 'application/json', [WORKER_LIFECYCLE_HEADER]: '1', ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }, onDispatch);
  assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
  return json(response, signal, value => {
    if (response.status !== status || response.headers.get(WORKER_LIFECYCLE_HEADER) !== '1') return malformed();
    return parse(value);
  });
};
export const getWorkerLifecycle = (workerId: string, signal: AbortSignal, admission: WorkerReadAdmission): Promise<LifecycleResource> => lifecycleRequest(workerId, '', signal, admission, 200, value => parseLifecycleResource(value, workerId));
export const submitWorkerLifecycle = (workerId: string, input: LifecycleIntentRequest, signal: AbortSignal, admission: WorkerReadAdmission, onDispatch: () => void): Promise<LifecycleIntentReceipt> => {
  const original = parseLifecycleIntentRequest(input);
  return lifecycleRequest(workerId, '/operations', signal, admission, 202, value => {
    const receipt = parseLifecycleIntentReceipt(value);
    if (receipt.workerId !== workerId || receipt.operationId !== original.operationId || receipt.action !== original.action || BigInt(receipt.intentVersion) !== BigInt(original.expectedVersion) + 1n) return malformed();
    return receipt;
  }, original, onDispatch);
};
export const getWorkerLifecycleOperation = (workerId: string, operationId: string, signal: AbortSignal, admission: WorkerReadAdmission): Promise<LifecycleOperationResult> => {
  uuid(operationId);
  return lifecycleRequest(workerId, `/operations/${operationId}`, signal, admission, 200, value => parseLifecycleOperationResult(value, workerId, operationId));
};
export const lifecycleIntentHash = async (input: LifecycleIntentRequest): Promise<string> => {
  const original = parseLifecycleIntentRequest(input);
  const canonical = Object.fromEntries(Object.keys(original).sort().map(key => [key, original[key as keyof typeof original]]));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`daynight.lifecycle.v1/intent\n${JSON.stringify(canonical)}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};
/** Bind recovered outcomes to the retained original request before clearing an unknown write. */
export const verifyLifecycleIntentResult = async (result: LifecycleOperationResult, workerId: string, input: LifecycleIntentRequest): Promise<LifecycleOperationResult> => {
  const original = parseLifecycleIntentRequest(input);
  if (result.receipt.workerId !== uuid(workerId) || result.receipt.operationId !== original.operationId) return malformed();
  if (result.kind === 'intent') {
    if (result.receipt.action !== original.action || BigInt(result.receipt.intentVersion) !== BigInt(original.expectedVersion) + 1n) return malformed();
  } else if (result.kind === 'not_committed') {
    if (result.receipt.requestKind !== 'intent' || result.receipt.requestHash !== await lifecycleIntentHash(original)) return malformed();
  } else return malformed();
  return result;
};
export const resolveWorkerLifecycleOperation = (workerId: string, input: LifecycleIntentRequest, signal: AbortSignal, admission: WorkerReadAdmission, onDispatch: () => void): Promise<LifecycleOperationResult> => {
  const original = parseLifecycleIntentRequest(input);
  return lifecycleRequest(workerId, `/operations/${original.operationId}/resolve`, signal, admission, 200, value => parseLifecycleOperationResult(value, workerId, original.operationId), { protocolVersion: 1, requestKind: 'intent', request: original }, onDispatch)
    .then(result => verifyLifecycleIntentResult(result, workerId, original));
};
