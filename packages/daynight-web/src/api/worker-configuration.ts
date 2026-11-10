import { ApiError, assertResponsePrincipal, json, request, requestId } from './client';
import { array, boolean, id, malformed, parseProjectPage, record, string, timestamp } from './parse';
import { decodeProjectPageJson } from './project-json';
import type { ProjectPage, WorkerAgent } from './types';
import type { WorkerReadAdmission } from './workers';

export type WorkerConfigurationNative = { readonly agent: WorkerAgent; readonly model: string | null; readonly args: readonly string[] };
export type WorkerConfigurationOverrides = { readonly agent?: WorkerAgent; readonly model?: string | null; readonly args?: readonly string[] };
export type WorkerControlMode = 'herdr' | 'web';
export type WorkerConfigurationValue = {
  readonly maxConcurrent: number; readonly pollIntervalMs: number; readonly recoveryLimit: number; readonly preferPlatformSpecificTasks: boolean;
  readonly agentControlMode?: WorkerControlMode | null;
  readonly native: WorkerConfigurationNative;
  readonly projects: readonly { readonly projectId: string; readonly nativeOverrides: WorkerConfigurationOverrides }[];
};
export type WorkerConfigurationDesired = { readonly revision: string; readonly updatedAt: string; readonly value: WorkerConfigurationValue };
export type WorkerConfigurationFailure = {
  readonly code: 'not_found' | 'permission_denied' | 'timeout' | 'command_failed' | 'invalid_output' | 'invalid_configuration' | 'io_error' | 'unavailable';
  readonly category: 'validation' | 'repository' | 'agent' | 'runtime' | 'storage';
  readonly phase: 'validate' | 'prepare' | 'apply' | 'stop' | 'persist'; readonly occurredAt: string;
};
export type WorkerConfigurationKey =
  | { readonly kind: 'maxConcurrent' | 'pollIntervalMs' | 'recoveryLimit' | 'preferPlatformSpecificTasks' | 'agentControlMode' | 'native' }
  | { readonly kind: 'projectPreparation' | 'projectRemoval' | 'projectNative'; readonly projectId: string };
export type WorkerConfigurationOutcome = {
  readonly key: WorkerConfigurationKey; readonly targetRevision: string;
  readonly appliedValue: number | WorkerConfigurationNative | WorkerControlMode | boolean | null;
  readonly state: 'pending' | 'applying' | 'applied' | 'error';
  readonly error: WorkerConfigurationFailure | null; readonly lastFailure: WorkerConfigurationFailure | null; readonly nextAttemptAt: string | null;
};
export type WorkerConfigurationObservation = {
  readonly baseRevision: string; readonly desiredRevision: string; readonly items: readonly WorkerConfigurationOutcome[]; readonly reportedAt: string;
};
export type WorkerConfigurationResource = {
  readonly desired: WorkerConfigurationDesired | null; readonly observationRevision: string; readonly observation: WorkerConfigurationObservation | null;
  readonly controlModeSupported?: boolean;
};

const fields = (value: unknown, names: readonly string[], optional = false): Record<string, unknown> => {
  const data = record(value);
  if (Object.keys(data).some(key => !names.includes(key)) || !optional && names.some(key => !Object.hasOwn(data, key))) return malformed();
  return data;
};
const choice = <T extends string>(value: unknown, choices: readonly T[]): T =>
  typeof value === 'string' && choices.includes(value as T) ? value as T : malformed();
export const isConfigurationText = (value: unknown): value is string =>
  typeof value === 'string' && value.isWellFormed() && /[^\p{White_Space}]/u.test(value) && !/\p{Cc}/u.test(value);
const text = (value: unknown): string => isConfigurationText(value) ? value : malformed();
export const parseConfigurationRevision = (value: unknown, allowZero = false): string => {
  const revision = string(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(revision) || BigInt(revision) > 9_223_372_036_854_775_807n || !allowZero && revision === '0') return malformed();
  return revision;
};
const configurationTimestamp = (value: unknown): string => {
  const parsed = timestamp(value);
  return /^0001-01-01T00:00:00(?:\.0{1,9})?Z$/.test(parsed) ? malformed() : parsed;
};
const integer = (value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : malformed();
const agent = (value: unknown): WorkerAgent => choice(value, ['codex', 'claude', 'copilot']);
export const parseConfigurationNative = (value: unknown): WorkerConfigurationNative => {
  const data = fields(value, ['agent', 'model', 'args']);
  return { agent: agent(data.agent), model: data.model === null ? null : text(data.model), args: array(data.args, text) };
};
const overrides = (value: unknown): WorkerConfigurationOverrides => {
  const data = fields(value, ['agent', 'model', 'args'], true);
  return {
    ...(Object.hasOwn(data, 'agent') ? { agent: agent(data.agent) } : {}),
    ...(Object.hasOwn(data, 'model') ? { model: data.model === null ? null : text(data.model) } : {}),
    ...(Object.hasOwn(data, 'args') ? { args: array(data.args, text) } : {}),
  };
};
export const parseWorkerConfigurationValue = (value: unknown, controlModeSupported = Object.hasOwn(record(value), 'agentControlMode')): WorkerConfigurationValue => {
  const data = fields(value, ['maxConcurrent', 'pollIntervalMs', 'recoveryLimit', 'preferPlatformSpecificTasks', 'native', 'projects', ...(controlModeSupported ? ['agentControlMode'] : [])]);
  const projects = array(data.projects, value => {
    const project = fields(value, ['projectId', 'nativeOverrides']);
    return { projectId: id(project.projectId), nativeOverrides: overrides(project.nativeOverrides) };
  }).sort((a, b) => a.projectId.localeCompare(b.projectId));
  if (new Set(projects.map(project => project.projectId)).size !== projects.length) return malformed();
  return { maxConcurrent: integer(data.maxConcurrent, 1), pollIntervalMs: integer(data.pollIntervalMs, 1, 2_147_483_647), recoveryLimit: integer(data.recoveryLimit, 0), preferPlatformSpecificTasks: boolean(data.preferPlatformSpecificTasks),
    ...(controlModeSupported ? { agentControlMode: data.agentControlMode === null ? null : choice(data.agentControlMode, ['herdr', 'web'] as const) } : {}),
    native: parseConfigurationNative(data.native), projects };
};
const failure = (value: unknown): WorkerConfigurationFailure | null => {
  if (value === null) return null;
  const data = fields(value, ['code', 'category', 'phase', 'occurredAt']);
  return { code: choice(data.code, ['not_found', 'permission_denied', 'timeout', 'command_failed', 'invalid_output', 'invalid_configuration', 'io_error', 'unavailable']),
    category: choice(data.category, ['validation', 'repository', 'agent', 'runtime', 'storage']), phase: choice(data.phase, ['validate', 'prepare', 'apply', 'stop', 'persist']), occurredAt: configurationTimestamp(data.occurredAt) };
};
const outcome = (value: unknown, controlModeSupported: boolean): WorkerConfigurationOutcome => {
  const data = fields(value, ['key', 'targetRevision', 'appliedValue', 'state', 'error', 'lastFailure', 'nextAttemptAt']);
  const rawKey = record(data.key);
  const projectKind = rawKey.kind === 'projectPreparation' || rawKey.kind === 'projectRemoval' || rawKey.kind === 'projectNative';
  fields(rawKey, projectKind ? ['kind', 'projectId'] : ['kind']);
  const key: WorkerConfigurationKey = projectKind
    ? { kind: choice(rawKey.kind, ['projectPreparation', 'projectRemoval', 'projectNative']), projectId: id(rawKey.projectId) }
    : { kind: choice(rawKey.kind, ['maxConcurrent', 'pollIntervalMs', 'recoveryLimit', 'preferPlatformSpecificTasks', 'native', ...(controlModeSupported ? ['agentControlMode' as const] : [])]) };
  let appliedValue: WorkerConfigurationOutcome['appliedValue'] = null;
  if (data.appliedValue !== null) {
    switch (key.kind) {
      case 'maxConcurrent': appliedValue = integer(data.appliedValue, 1); break;
      case 'pollIntervalMs': appliedValue = integer(data.appliedValue, 1, 2_147_483_647); break;
      case 'recoveryLimit': appliedValue = integer(data.appliedValue, 0); break;
      case 'preferPlatformSpecificTasks': appliedValue = boolean(data.appliedValue); break;
      case 'agentControlMode': appliedValue = choice(data.appliedValue, ['herdr', 'web'] as const); break;
      case 'native': case 'projectNative': appliedValue = parseConfigurationNative(data.appliedValue); break;
      case 'projectPreparation': case 'projectRemoval': if (data.appliedValue !== true) return malformed(); appliedValue = true;
    }
  }
  const state = choice(data.state, ['pending', 'applying', 'applied', 'error']), error = failure(data.error);
  const nextAttemptAt = data.nextAttemptAt === null ? null : configurationTimestamp(data.nextAttemptAt);
  if ((state === 'error') !== (error !== null) || state === 'applied' && appliedValue === null || state !== 'error' && nextAttemptAt !== null) return malformed();
  return { key, targetRevision: parseConfigurationRevision(data.targetRevision), appliedValue, state, error, lastFailure: failure(data.lastFailure), nextAttemptAt };
};
export const parseWorkerConfiguration = (value: unknown, controlModeSupported = false): WorkerConfigurationResource => {
  const data = fields(value, ['desired', 'observationRevision', 'observation']);
  const observationRevision = parseConfigurationRevision(data.observationRevision, true);
  let desired: WorkerConfigurationDesired | null = null, observation: WorkerConfigurationObservation | null = null;
  if (data.desired !== null) {
    const raw = fields(data.desired, ['revision', 'updatedAt', 'value']);
    desired = { revision: parseConfigurationRevision(raw.revision), updatedAt: configurationTimestamp(raw.updatedAt), value: parseWorkerConfigurationValue(raw.value, controlModeSupported) };
  }
  if (data.observation !== null) {
    const raw = fields(data.observation, ['baseRevision', 'desiredRevision', 'items', 'reportedAt']);
    const items = array(raw.items, item => outcome(item, controlModeSupported)), desiredRevision = parseConfigurationRevision(raw.desiredRevision);
    if (new Set(items.map(item => `${item.key.kind}/${'projectId' in item.key ? item.key.projectId : ''}`)).size !== items.length || items.some(item => BigInt(item.targetRevision) > BigInt(desiredRevision))) return malformed();
    observation = { baseRevision: parseConfigurationRevision(raw.baseRevision, true), desiredRevision, items, reportedAt: configurationTimestamp(raw.reportedAt) };
    if (desired === null || BigInt(desiredRevision) > BigInt(desired.revision) || BigInt(observation.baseRevision) + 1n !== BigInt(observationRevision)) return malformed();
  }
  if ((observationRevision === '0') !== (observation === null) || desired === null && observation !== null) return malformed();
  return { desired, observationRevision, observation, ...(controlModeSupported ? { controlModeSupported: true } : {}) };
};

export type WorkerConfigurationWriteAdmission = WorkerReadAdmission & { readonly onDispatch?: () => void; readonly controlModeSupported?: boolean };
const url = (workerId: string) => `/api/v1/me/workers/${requestId(workerId)}/configuration`;
export const getWorkerConfiguration = async (workerId: string, signal: AbortSignal, admission: WorkerReadAdmission): Promise<WorkerConfigurationResource> => {
  const userId = requestId(admission.userId);
  const response = await request(url(workerId), signal, { headers: { Accept: 'application/json', 'Daynight-Worker-Control-Mode': '1' } });
  assertResponsePrincipal(response, userId, admission.onPrincipalMismatch);
  return json(response, signal, data => {
    if (response.status !== 200 || response.headers.get('Daynight-Worker-Configuration') !== '1') throw new ApiError('protocol', response.status);
    return parseWorkerConfiguration(data, response.headers.get('Daynight-Worker-Control-Mode') === '1');
  });
};
export const saveWorkerConfiguration = async (workerId: string, revision: string, value: WorkerConfigurationValue, signal: AbortSignal, admission: WorkerConfigurationWriteAdmission): Promise<WorkerConfigurationResource> => {
  const supported = admission.controlModeSupported === true;
  const userId = requestId(admission.userId), expected = parseConfigurationRevision(revision), validated = parseWorkerConfigurationValue(value, supported);
  const response = await request(url(workerId), signal, { method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(supported ? { 'Daynight-Worker-Control-Mode': '1' } : {}) }, body: JSON.stringify({ revision: expected, value: validated }) }, admission.onDispatch);
  assertResponsePrincipal(response, userId, admission.onPrincipalMismatch);
  return json(response, signal, data => {
    if (response.status !== 200 || response.headers.get('Daynight-Worker-Configuration') !== '1') throw new ApiError('protocol', response.status);
    if (supported && response.headers.get('Daynight-Worker-Control-Mode') !== '1') throw new ApiError('protocol', response.status);
    const resource = parseWorkerConfiguration(data, response.headers.get('Daynight-Worker-Control-Mode') === '1');
    if (resource.desired === null || BigInt(resource.desired.revision) < BigInt(expected) || BigInt(resource.desired.revision) > BigInt(expected) + 1n || JSON.stringify(resource.desired.value) !== JSON.stringify(validated)) throw new ApiError('protocol', response.status);
    return resource;
  });
};
export const listWorkerConfigurationProjects = async (query: { readonly limit?: number; readonly cursor?: string }, signal: AbortSignal, admission: WorkerReadAdmission): Promise<ProjectPage> => {
  const userId = requestId(admission.userId), parameters = new URLSearchParams();
  if (query.limit !== undefined) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new ApiError('protocol');
    parameters.set('limit', String(query.limit));
  }
  if (query.cursor !== undefined) {
    if (query.cursor === '') throw new ApiError('protocol');
    parameters.set('cursor', query.cursor);
  }
  const response = await request(`/api/v1/projects${parameters.size === 0 ? '' : `?${parameters}`}`, signal, { headers: { Accept: 'application/json' } });
  assertResponsePrincipal(response, userId, admission.onPrincipalMismatch);
  return json(response, signal, data => { if (response.status !== 200) throw new ApiError('protocol', response.status); return parseProjectPage(data); }, decodeProjectPageJson);
};
