import { decodeStrictSessionJson } from '../../../daynight/src/session/v2/values';
import { ApiError, assertResponsePrincipal, json, request, requestId } from './client';
import { array, boolean, count, malformed, record, string, timestamp } from './validation';
import type { WorkerReadAdmission } from './workers';

const schedulerPhases = ['initializing', 'configuration', 'inventory', 'project-preparation', 'resource-observation', 'reconciliation', 'claim-search', 'claim-request', 'archive-backfill', 'waiting-poll', 'stopping', 'stopped'] as const;
const executionPhases = ['observation', 'worktree-preparation', 'agent-start', 'agent-observation', 'input-submission', 'preparing', 'executing', 'verifying', 'completing', 'waiting', 'paused'] as const;
const cleanupPhases = ['observation', 'agent-stop', 'backend-close', 'archive', 'worktree-removal'] as const;
const deliveryPhases = ['read', 'write', 'reconcile', 'shutdown'] as const;
const reasons = ['configuration-unavailable', 'configuration-incomplete', 'inventory-unavailable', 'project-unavailable', 'project-preparation-failed', 'resource-observation-unavailable', 'capacity-full', 'cleanup-capacity-blocked', 'no-projects-selected', 'no-ready-tasks', 'claim-unconfirmed', 'retained-resource-conflict', 'stopping'] as const;
const waits = ['native-input', 'retry-backoff', 'task-paused', 'resource-stop', 'operation-lock', 'recovery-blocked', 'initializing', 'unknown'] as const;
const components = ['runtime', 'scheduler', 'configuration', 'inventory', 'project', 'resources', 'execution', 'cleanup', 'archive', 'monitoring'] as const;
const roles = ['active-task', 'resource-owner', 'unresolved', 'cleanup', 'pending-stop'] as const;
const causes = {
  cancelled: 'The operation was cancelled.', timeout: 'The operation timed out.', 'authentication-required': 'Authentication is required.',
  'limit-exceeded': 'An operation limit was exceeded.', 'rate-limited': 'The operation was rate limited.', 'permission-denied': 'Permission was denied.',
  'not-found-or-inaccessible': 'A required resource was not found or is inaccessible.', 'not-found': 'A required resource was not found.', conflict: 'The operation encountered a conflict.',
  unavailable: 'A required service or resource is unavailable.', 'invalid-response': 'The response was invalid.', 'resource-exhausted': 'A required resource was exhausted.',
  'configuration-missing': 'Required configuration is missing.', 'configuration-invalid': 'The configuration is invalid.', 'command-failed': 'A required command failed.',
  'io-error': 'A required I/O operation failed.', 'invalid-output': 'A required operation produced invalid output.', 'recovery-limit': 'The recovery limit was reached.',
  'native-identity-missing': 'The original native execution identity is missing.', 'worktree-validation-failed': 'The worktree failed ownership validation.',
  'branch-mismatch': 'The worktree branch does not match the recorded owner.', 'recovery-blocked': 'Recovery is blocked and needs attention.',
  'outcome-unknown': 'The operation outcome is unknown.', unknown: 'The operation failed; inspect local Worker diagnostics for details.',
} as const;

type Choice<T extends readonly string[]> = T[number];
export type SchedulerPhase = Choice<typeof schedulerPhases>;
export type MonitoringReasonCode = Choice<typeof reasons>;
export type MonitoringWaitReason = Choice<typeof waits>;
export type MonitoringComponent = Choice<typeof components>;
export type MonitoringDiagnosticCode = keyof typeof causes;
export type MonitoringScope = { kind: 'worker' } | { kind: 'project'; projectId: string } | { kind: 'claim'; projectId: string; taskId: string; claimId: string };
export type MonitoringAssociation = null | { kind: 'project'; projectName: string } | { kind: 'task'; projectName: string; title: string } | { kind: 'labels-omitted' };
export type Coverage = 'unknown' | 'complete' | 'partial';
export type DetailCoverage = 'complete' | 'partial';
export type MonitoringCapacity = { observedAt: string; quality: 'current' | 'stale'; limit: number; occupied: number; available: number };
export type MonitoringSummaryAdmission = { observedAt: string; coverage: Coverage; reasonCodes: readonly MonitoringReasonCode[]; permissionProjection: 'current' | 'restricted' };
export type MonitoringSummary = { capturedAt: string; lifecycle: 'starting' | 'running' | 'stopping' | 'stopped'; scheduler: { phase: SchedulerPhase; coverage: Coverage; lastSuccessfulAt: string | null; nextPollAt: string | null }; capacity: MonitoringCapacity | null; detailCoverage: DetailCoverage; admission: MonitoringSummaryAdmission };
type Scoped = { scope: MonitoringScope; association: MonitoringAssociation };
export type MonitoringReason = Scoped & { code: MonitoringReasonCode; observedAt: string; nextAttemptAt: string | null };
export type MonitoringReservation = Scoped & { reservationId: string; roles: readonly Choice<typeof roles>[]; occupied: boolean; observedAt: string };
export type MonitoringActivity = Scoped & { kind: 'execution' | 'cleanup' | 'maintenance'; phase: Choice<typeof executionPhases> | Choice<typeof cleanupPhases> | SchedulerPhase; operationId: string; status: 'queued' | 'running' | 'waiting' | 'paused'; startedAt: string; lastProgressAt: string | null; elapsedMs: number; deadlineAt: string | null; waitReason: MonitoringWaitReason | null; nextAttemptAt: string | null };
export type MonitoringCause = { type: 'operation'; code: MonitoringDiagnosticCode; cause: string; causeTruncated: false };
export type MonitoringFailure = Scoped & { operationId: string; component: MonitoringComponent; phase: string; error: MonitoringCause; firstObservedAt: string; lastObservedAt: string; occurrencesInRun: number; retryState: 'none' | 'scheduled' | 'running' | 'manual'; nextAttemptAt: string | null };
export type MonitoringRecovery = Scoped & { operationId: string; component: MonitoringComponent; observedAt: string; explanation: string; explanationTruncated: false };
export type MonitoringObservation = { runId: string; sequence: string; capturedAt: string; lifecycle: MonitoringSummary['lifecycle']; scheduler: MonitoringSummary['scheduler'] & { cycleId: string | null; lastCompletedAt: string | null; lastOutcome: 'completed' | 'failed' | 'cancelled' | null }; capacity: (MonitoringCapacity & { detailCoverage: DetailCoverage }) | null; admission: { observedAt: string; coverage: Coverage; reasons: readonly MonitoringReason[] }; reservations: readonly MonitoringReservation[]; activities: readonly MonitoringActivity[]; currentFailures: readonly MonitoringFailure[]; lastRecovery: MonitoringRecovery | null; detailCoverage: DetailCoverage; delivery: { lastSucceededAt: string | null; lastFailure: { observedAt: string; phase: Choice<typeof deliveryPhases>; error: MonitoringCause; requestId: string | null } | null } };
export type WorkerMonitoringDetail = { observedAt: string; detailCoverage: DetailCoverage; permissionProjection: 'current' | 'restricted' } & ({ state: 'absent'; revision: null; runId: null; sequence: null; receivedAt: null; expiresAt: null; data: null } | { state: 'available'; revision: string; runId: string; sequence: string; receivedAt: string; expiresAt: string; data: MonitoringObservation });
export type WorkerMonitoringItem = { workerId: string } & ({ state: 'absent'; revision: null; receivedAt: null; expiresAt: null; summary: null } | { state: 'available'; revision: string; receivedAt: string; expiresAt: string; summary: MonitoringSummary });
export type WorkerMonitoringQuery = { observedAt: string; items: readonly WorkerMonitoringItem[] };

const fields = (value: unknown, names: readonly string[]): Record<string, unknown> => {
  const data = record(value);
  if (Object.keys(data).length !== names.length || names.some(name => !Object.hasOwn(data, name))) return malformed();
  return data;
};
const choice = <T extends readonly string[]>(value: unknown, choices: T): T[number] => typeof value === 'string' && choices.includes(value) ? value : malformed();
const uuid = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : malformed();
const sequence = (value: unknown): string => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n ? value : malformed();
const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value);
const text = (value: unknown): string => { const s = string(value); return s.isWellFormed() && s.length > 0 && !s.includes('\0') ? s : malformed(); };
const monitoringCount = (value: unknown): number => { const n = count(value); return n === 0 ? 0 : n; };
const coverage = (value: unknown): Coverage => choice(value, ['unknown', 'complete', 'partial'] as const);
const detail = (value: unknown): DetailCoverage => choice(value, ['complete', 'partial'] as const);
const lifecycle = (value: unknown): MonitoringSummary['lifecycle'] => choice(value, ['starting', 'running', 'stopping', 'stopped'] as const);
const phase = (value: unknown): SchedulerPhase => choice(value, schedulerPhases);
const limited = <T>(value: unknown, parse: (v: unknown) => T, max: number): T[] => { const result = array(value, parse); return result.length <= max ? result : malformed(); };
const scope = (value: unknown): MonitoringScope => {
  const data = record(value);
  if (data.kind === 'worker') { fields(data, ['kind']); return { kind: 'worker' }; }
  if (data.kind === 'project') { fields(data, ['kind', 'projectId']); return { kind: 'project', projectId: uuid(data.projectId) }; }
  if (data.kind === 'claim') { fields(data, ['kind', 'projectId', 'taskId', 'claimId']); return { kind: 'claim', projectId: uuid(data.projectId), taskId: uuid(data.taskId), claimId: uuid(data.claimId) }; }
  return malformed();
};
const association = (value: unknown, owner: MonitoringScope): MonitoringAssociation => {
  if (value === null) return owner.kind === 'worker' ? null : malformed();
  const data = record(value);
  if (data.kind === 'labels-omitted' && owner.kind !== 'worker') { fields(data, ['kind']); return { kind: 'labels-omitted' }; }
  if (data.kind === 'project' && owner.kind === 'project') { fields(data, ['kind', 'projectName']); return { kind: 'project', projectName: text(data.projectName) }; }
  if (data.kind === 'task' && owner.kind === 'claim') { fields(data, ['kind', 'projectName', 'title']); return { kind: 'task', projectName: text(data.projectName), title: text(data.title) }; }
  return malformed();
};
const scoped = (data: Record<string, unknown>): Scoped => { const s = scope(data.scope); return { scope: s, association: association(data.association, s) }; };
const capacity = (value: unknown, withCoverage: boolean): MonitoringCapacity & { detailCoverage?: DetailCoverage } => {
  const d = fields(value, ['observedAt', 'quality', 'limit', 'occupied', 'available', ...(withCoverage ? ['detailCoverage'] : [])]);
  const limit = monitoringCount(d.limit), occupied = monitoringCount(d.occupied), available = monitoringCount(d.available);
  if (limit < 1 || limit > 64 || available !== Math.max(0, limit - occupied)) return malformed();
  return { observedAt: timestamp(d.observedAt), quality: choice(d.quality, ['current', 'stale'] as const), limit, occupied, available, ...(withCoverage ? { detailCoverage: detail(d.detailCoverage) } : {}) };
};
const cause = (value: unknown): MonitoringCause => {
  const d = fields(value, ['type', 'code', 'cause', 'causeTruncated']);
  const code = choice(d.code, Object.keys(causes) as MonitoringDiagnosticCode[]);
  if (d.type !== 'operation' || d.cause !== causes[code] || d.causeTruncated !== false) return malformed();
  return { type: 'operation', code, cause: causes[code], causeTruncated: false };
};
const reason = (value: unknown): MonitoringReason => {
  const d = fields(value, ['code', 'scope', 'observedAt', 'nextAttemptAt', 'association']);
  const result = { ...scoped(d), code: choice(d.code, reasons), observedAt: timestamp(d.observedAt), nextAttemptAt: nullable(d.nextAttemptAt, timestamp) };
  if (result.scope.kind === 'worker' && (result.code === 'project-unavailable' || result.code === 'project-preparation-failed')) return malformed();
  return result;
};
const reservation = (value: unknown): MonitoringReservation => {
  const d = fields(value, ['reservationId', 'scope', 'roles', 'occupied', 'observedAt', 'association']);
  const reservationId = uuid(d.reservationId), parsedRoles = limited(d.roles, v => choice(v, roles), 5);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reservationId) || parsedRoles.length === 0 || new Set(parsedRoles).size !== parsedRoles.length) return malformed();
  return { ...scoped(d), reservationId, roles: parsedRoles, occupied: boolean(d.occupied), observedAt: timestamp(d.observedAt) };
};
const activity = (value: unknown): MonitoringActivity => {
  const d = fields(value, ['kind', 'phase', 'operationId', 'status', 'scope', 'startedAt', 'lastProgressAt', 'elapsedMs', 'deadlineAt', 'waitReason', 'nextAttemptAt', 'association']);
  const kind = choice(d.kind, ['execution', 'cleanup', 'maintenance'] as const);
  return { ...scoped(d), kind, phase: kind === 'execution' ? choice(d.phase, executionPhases) : kind === 'cleanup' ? choice(d.phase, cleanupPhases) : phase(d.phase), operationId: uuid(d.operationId), status: choice(d.status, ['queued', 'running', 'waiting', 'paused'] as const), startedAt: timestamp(d.startedAt), lastProgressAt: nullable(d.lastProgressAt, timestamp), elapsedMs: monitoringCount(d.elapsedMs), deadlineAt: nullable(d.deadlineAt, timestamp), waitReason: nullable(d.waitReason, v => choice(v, waits)), nextAttemptAt: nullable(d.nextAttemptAt, timestamp) };
};
const failure = (value: unknown): MonitoringFailure => {
  const d = fields(value, ['operationId', 'component', 'phase', 'scope', 'error', 'firstObservedAt', 'lastObservedAt', 'occurrencesInRun', 'retryState', 'nextAttemptAt', 'association']);
  const component = choice(d.component, components), parsedScope = scoped(d), retryState = choice(d.retryState, ['none', 'scheduled', 'running', 'manual'] as const), nextAttemptAt = nullable(d.nextAttemptAt, timestamp);
  if ((retryState === 'scheduled') !== (nextAttemptAt !== null) || (component === 'project' && parsedScope.scope.kind === 'worker')) return malformed();
  const parsedPhase = component === 'execution' ? choice(d.phase, executionPhases) : component === 'cleanup' ? choice(d.phase, cleanupPhases) : component === 'monitoring' ? choice(d.phase, deliveryPhases) : phase(d.phase);
  return { ...parsedScope, component, phase: parsedPhase, operationId: uuid(d.operationId), error: cause(d.error), firstObservedAt: timestamp(d.firstObservedAt), lastObservedAt: timestamp(d.lastObservedAt), occurrencesInRun: monitoringCount(d.occurrencesInRun), retryState, nextAttemptAt };
};
const recovery = (value: unknown): MonitoringRecovery => {
  const d = fields(value, ['operationId', 'component', 'scope', 'observedAt', 'explanation', 'explanationTruncated', 'association']);
  const component = choice(d.component, components), parsedScope = scoped(d);
  if (d.explanation !== 'The operation recovered.' || d.explanationTruncated !== false || (component === 'project' && parsedScope.scope.kind === 'worker')) return malformed();
  return { ...parsedScope, operationId: uuid(d.operationId), component, observedAt: timestamp(d.observedAt), explanation: d.explanation, explanationTruncated: false };
};
const summary = (value: unknown): MonitoringSummary => {
  const d = fields(value, ['capturedAt', 'lifecycle', 'scheduler', 'capacity', 'detailCoverage', 'admission']);
  const s = fields(d.scheduler, ['phase', 'coverage', 'lastSuccessfulAt', 'nextPollAt']);
  const a = fields(d.admission, ['observedAt', 'coverage', 'reasonCodes', 'permissionProjection']);
  const reasonCodes = limited(a.reasonCodes, v => choice(v, reasons), reasons.length);
  const admissionCoverage = coverage(a.coverage);
  // The protocol fixes the order independently of lexical sorting and forbids duplicates.
  if (reasonCodes.some((code, index) => index > 0 && reasons.indexOf(reasonCodes[index - 1]!) >= reasons.indexOf(code)) ||
      admissionCoverage !== 'complete' && reasonCodes.includes('no-ready-tasks')) return malformed();
  return { capturedAt: timestamp(d.capturedAt), lifecycle: lifecycle(d.lifecycle), scheduler: { phase: phase(s.phase), coverage: coverage(s.coverage), lastSuccessfulAt: nullable(s.lastSuccessfulAt, timestamp), nextPollAt: nullable(s.nextPollAt, timestamp) }, capacity: nullable(d.capacity, v => capacity(v, false)), detailCoverage: detail(d.detailCoverage), admission: { observedAt: timestamp(a.observedAt), coverage: admissionCoverage, reasonCodes, permissionProjection: choice(a.permissionProjection, ['current', 'restricted'] as const) } };
};
const observation = (value: unknown): MonitoringObservation => {
  const d = fields(value, ['runId', 'sequence', 'capturedAt', 'lifecycle', 'scheduler', 'capacity', 'admission', 'reservations', 'activities', 'currentFailures', 'lastRecovery', 'detailCoverage', 'delivery']);
  const s = fields(d.scheduler, ['phase', 'coverage', 'cycleId', 'lastCompletedAt', 'lastSuccessfulAt', 'lastOutcome', 'nextPollAt']);
  const a = fields(d.admission, ['observedAt', 'coverage', 'reasons']), delivery = fields(d.delivery, ['lastSucceededAt', 'lastFailure']);
  const parsedReasons = limited(a.reasons, reason, 16), admissionCoverage = coverage(a.coverage), admissionAt = timestamp(a.observedAt);
  const globalCleanup = parsedReasons.filter(r => r.code === 'cleanup-capacity-blocked' && r.scope.kind === 'worker');
  if (parsedReasons.some(r => r.code === 'no-ready-tasks' && admissionCoverage !== 'complete') || globalCleanup.length > 1 || globalCleanup.some(r => r.observedAt !== admissionAt || r.nextAttemptAt !== null)) return malformed();
  const reservations = limited(d.reservations, reservation, 128);
  if (new Set(reservations.map(r => r.reservationId)).size !== reservations.length) return malformed();
  const parsedCapacity = nullable(d.capacity, v => { const c = capacity(v, true); return { ...c, detailCoverage: detail(c.detailCoverage) }; });
  return { runId: uuid(d.runId), sequence: sequence(d.sequence), capturedAt: timestamp(d.capturedAt), lifecycle: lifecycle(d.lifecycle), scheduler: { phase: phase(s.phase), coverage: coverage(s.coverage), cycleId: nullable(s.cycleId, uuid), lastCompletedAt: nullable(s.lastCompletedAt, timestamp), lastSuccessfulAt: nullable(s.lastSuccessfulAt, timestamp), lastOutcome: nullable(s.lastOutcome, v => choice(v, ['completed', 'failed', 'cancelled'] as const)), nextPollAt: nullable(s.nextPollAt, timestamp) }, capacity: parsedCapacity, admission: { observedAt: admissionAt, coverage: admissionCoverage, reasons: parsedReasons }, reservations, activities: limited(d.activities, activity, 128), currentFailures: limited(d.currentFailures, failure, 32), lastRecovery: nullable(d.lastRecovery, recovery), detailCoverage: detail(d.detailCoverage), delivery: { lastSucceededAt: nullable(delivery.lastSucceededAt, timestamp), lastFailure: nullable(delivery.lastFailure, v => { const f = fields(v, ['observedAt', 'phase', 'error', 'requestId']); return { observedAt: timestamp(f.observedAt), phase: choice(f.phase, deliveryPhases), error: cause(f.error), requestId: nullable(f.requestId, uuid) }; }) } };
};
export const parseWorkerMonitoringDetail = (value: unknown): WorkerMonitoringDetail => {
  const d = fields(value, ['observedAt', 'state', 'revision', 'runId', 'sequence', 'receivedAt', 'expiresAt', 'data', 'detailCoverage', 'permissionProjection']);
  const observedAt = timestamp(d.observedAt), detailCoverage = detail(d.detailCoverage), permissionProjection = choice(d.permissionProjection, ['current', 'restricted'] as const);
  if (d.state === 'absent') {
    if ([d.revision, d.runId, d.sequence, d.receivedAt, d.expiresAt, d.data].some(v => v !== null) || detailCoverage !== 'complete' || permissionProjection !== 'current') return malformed();
    return { observedAt, state: 'absent', revision: null, runId: null, sequence: null, receivedAt: null, expiresAt: null, data: null, detailCoverage, permissionProjection };
  }
  if (d.state !== 'available') return malformed();
  const data = observation(d.data), runId = uuid(d.runId), seq = sequence(d.sequence);
  if (data.runId !== runId || data.sequence !== seq || data.detailCoverage !== detailCoverage) return malformed();
  return { observedAt, state: 'available', revision: uuid(d.revision), runId, sequence: seq, receivedAt: timestamp(d.receivedAt), expiresAt: timestamp(d.expiresAt), data, detailCoverage, permissionProjection };
};
export const parseWorkerMonitoringQuery = (value: unknown, workerIds: readonly string[]): WorkerMonitoringQuery => {
  const d = fields(value, ['observedAt', 'items']);
  const items = limited(d.items, (value): WorkerMonitoringItem => {
    const item = fields(value, ['workerId', 'state', 'revision', 'receivedAt', 'expiresAt', 'summary']), workerId = uuid(item.workerId);
    if (item.state === 'absent') {
      if ([item.revision, item.receivedAt, item.expiresAt, item.summary].some(v => v !== null)) return malformed();
      return { workerId, state: 'absent', revision: null, receivedAt: null, expiresAt: null, summary: null };
    }
    if (item.state !== 'available') return malformed();
    return { workerId, state: 'available', revision: uuid(item.revision), receivedAt: timestamp(item.receivedAt), expiresAt: timestamp(item.expiresAt), summary: summary(item.summary) };
  }, 100);
  if (items.length !== workerIds.length || items.some((item, index) => item.workerId !== workerIds[index])) return malformed();
  return { observedAt: timestamp(d.observedAt), items };
};
// Every numeric field in a successful monitoring DTO is a nonnegative safe
// integer. Inspect its source token before Number can round a fractional or
// out-of-range value into an apparently valid integer.
const validateMonitoringNumbers = (source: string): void => {
  const token = /(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?/y;
  for (let at = 0; at < source.length;) {
    if (source[at] === '"') {
      at++;
      while (at < source.length && source[at] !== '"') at += source[at] === '\\' ? 2 : 1;
      at++;
      continue;
    }
    if (source[at] !== '-' && !/[0-9]/.test(source[at]!)) { at++; continue; }
    token.lastIndex = at;
    const match = token.exec(source);
    if (match === null) return malformed();
    at = token.lastIndex;
    const fraction = match[3] ?? '';
    const digits = (match[2]! + fraction).replace(/^0+/, '');
    if (digits === '') continue;
    if (match[1] === '-') return malformed();
    const exponentText = match[4] ?? '0';
    const magnitude = exponentText.replace(/^[+-]?0*/, '');
    if (magnitude.length > 6) return malformed();
    const exponent = (exponentText.startsWith('-') ? -1 : 1) * Number(magnitude || '0');
    const significant = digits.replace(/0+$/, '');
    const scale = exponent - fraction.length + digits.length - significant.length;
    if (scale < 0 || scale > 16 || significant.length + scale > 16 || BigInt(significant + '0'.repeat(scale)) > 9007199254740991n) return malformed();
  }
};

// Inspect the original bytes before object keys can be collapsed by JSON.parse.
// The service owns these encoded response budgets, including the final newline.
const decodeMonitoringJson = async (response: Response, signal: AbortSignal, limit: number): Promise<unknown> => {
  if (response.body === null) throw new Error('Missing monitoring response body');
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(limit))) {
    void response.body.cancel().catch(() => undefined);
    throw new Error('Monitoring response exceeds its budget');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error('Monitoring response exceeds its budget');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = decodeStrictSessionJson(bytes, limit);
    if (response.ok) validateMonitoringNumbers(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    return value;
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};
const admitMonitoringResponse = (response: Response, userId: string, onPrincipalMismatch: () => void): void => {
  try { assertResponsePrincipal(response, userId, onPrincipalMismatch); }
  catch (error) { if (response.body !== null) void response.body.cancel().catch(() => undefined); throw error; }
};
export const getWorkerMonitoring = async (workerId: string, signal: AbortSignal, admission: WorkerReadAdmission): Promise<WorkerMonitoringDetail> => {
  const userId = requestId(admission.userId), canonicalWorkerId = requestId(workerId);
  const response = await request(`/api/v1/me/workers/${canonicalWorkerId}/monitoring`, signal, { headers: { Accept: 'application/json' } });
  admitMonitoringResponse(response, userId, admission.onPrincipalMismatch);
  return json(response, signal, value => { if (response.status !== 200) throw new ApiError('protocol', response.status); return parseWorkerMonitoringDetail(value); }, response => decodeMonitoringJson(response, signal, 512 * 1024));
};
export const queryWorkerMonitoring = async (workerIds: readonly string[], signal: AbortSignal, admission: WorkerReadAdmission): Promise<WorkerMonitoringQuery> => {
  const userId = requestId(admission.userId), ids = workerIds.map(requestId);
  if (ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length) throw new ApiError('protocol');
  const response = await request('/api/v1/me/workers/monitoring/query', signal, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ workerIds: ids }) });
  admitMonitoringResponse(response, userId, admission.onPrincipalMismatch);
  return json(response, signal, value => { if (response.status !== 200) throw new ApiError('protocol', response.status); return parseWorkerMonitoringQuery(value, ids); }, response => decodeMonitoringJson(response, signal, 256 * 1024));
};
