import { parseWorkerCloudToolPaths, workerConfigurationCapabilities, type WorkerCloudToolPaths, type WorkerConfigurationCapabilityInput } from "./worker-tool-paths";
import { ApiError, assertResponsePrincipal, json, request, requestId } from './client';
import { array, boolean, id, malformed, parseProjectPage, record, string, timestamp } from './parse';
import { decodeProjectPageJson } from './project-json';
import { parseApiJson } from './json';
import { configurationBaseline, configurationValueSourcesEqual, decodeConfigurationDocument, encodeConfigurationPut, unsupportedConfigurationFields, withoutArchiveSessions, type ConfigurationBaseline, type ConfigurationDocument, type ConfigurationSubmission } from './configuration-source';
import type { ProjectPage, WorkerAgent } from './types';
import type { WorkerReadAdmission } from './workers';
import { parseWorkerTaskTagFilter, type WorkerTaskTagFilter } from './worker-task-tag-filter';

export type WorkerConfigurationNative = { readonly agent: WorkerAgent; readonly model: string | null; readonly args: readonly string[] };
export type WorkerConfigurationOverrides = { readonly agent?: WorkerAgent; readonly model?: string | null; readonly args?: readonly string[] };
export type WorkerControlMode = 'herdr' | 'web';
export type WorkerConfigurationValue = {
  readonly maxConcurrent: number; readonly pollIntervalMs: number; readonly recoveryLimit: number; readonly preferPlatformSpecificTasks: boolean;
  readonly agentControlMode?: WorkerControlMode | null;
  readonly archiveSessions?: boolean;
  readonly enableSudoCleanup?: boolean;
  readonly toolPaths?: WorkerCloudToolPaths;
  readonly taskTagFilter?: WorkerTaskTagFilter;
  readonly native: WorkerConfigurationNative;
  readonly projects: readonly { readonly projectId: string; readonly nativeOverrides: WorkerConfigurationOverrides }[];
};
export type WorkerConfigurationDesired = { readonly revision: string; readonly updatedAt: string; readonly value: WorkerConfigurationValue; readonly document?: ConfigurationDocument };
export type WorkerConfigurationFailure = {
  readonly code: 'not_found' | 'permission_denied' | 'timeout' | 'command_failed' | 'invalid_output' | 'invalid_configuration' | 'io_error' | 'unavailable';
  readonly category: 'validation' | 'repository' | 'agent' | 'runtime' | 'storage';
  readonly phase: 'validate' | 'prepare' | 'apply' | 'stop' | 'persist'; readonly occurredAt: string;
};
export type WorkerConfigurationKey =
  | { readonly kind: 'maxConcurrent' | 'pollIntervalMs' | 'recoveryLimit' | 'preferPlatformSpecificTasks' | 'agentControlMode' | 'archiveSessions' | 'enableSudoCleanup' | 'native' | 'taskTagFilter' }
  | { readonly kind: 'projectPreparation' | 'projectRemoval' | 'projectNative'; readonly projectId: string };
export type WorkerConfigurationOutcome = {
  readonly key: WorkerConfigurationKey; readonly targetRevision: string;
  readonly appliedValue: number | WorkerConfigurationNative | string | boolean | null;
  readonly state: 'pending' | 'applying' | 'applied' | 'error';
  readonly error: WorkerConfigurationFailure | null; readonly lastFailure: WorkerConfigurationFailure | null; readonly nextAttemptAt: string | null;
};
export type WorkerConfigurationObservation = {
  readonly baseRevision: string; readonly desiredRevision: string; readonly items: readonly WorkerConfigurationOutcome[]; readonly reportedAt: string;
  readonly document?: ConfigurationDocument;
};
export type WorkerConfigurationResource = {
  readonly desired: WorkerConfigurationDesired | null; readonly observationRevision: string; readonly observation: WorkerConfigurationObservation | null;
  readonly document?: ConfigurationDocument;
  readonly controlModeSupported?: boolean;
  readonly toolPathsSupported?: boolean;
  readonly archiveSessionsSupported?: boolean;
};

const fields = (value: unknown, names: readonly string[], optional = false, allowUnknown = false): Record<string, unknown> => {
  const data = record(value);
  if (!allowUnknown && Object.keys(data).some(key => !names.includes(key)) || !optional && names.some(key => !Object.hasOwn(data, key))) return malformed();
  return data;
};
const knownToolPaths = (value: unknown): unknown => {
  const data = record(value);
  return Object.fromEntries(['codex', 'copilot'].filter(key => Object.hasOwn(data, key)).map(key => {
    const raw = data[key];
    if (raw === null) return [key, null];
    const choice = record(raw);
    return [key, Object.fromEntries(['kind', 'path'].filter(member => Object.hasOwn(choice, member)).map(member => [member, choice[member]]))];
  }));
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
  const data = fields(value, ['agent', 'model', 'args'], false, true);
  return { agent: agent(data.agent), model: data.model === null ? null : text(data.model), args: array(data.args, text) };
};
const overrides = (value: unknown): WorkerConfigurationOverrides => {
  const data = fields(value, ['agent', 'model', 'args'], true, true);
  return {
    ...(Object.hasOwn(data, 'agent') ? { agent: agent(data.agent) } : {}),
    ...(Object.hasOwn(data, 'model') ? { model: data.model === null ? null : text(data.model) } : {}),
    ...(Object.hasOwn(data, 'args') ? { args: array(data.args, text) } : {}),
  };
};
export const parseWorkerConfigurationValue = (value: unknown, options: WorkerConfigurationCapabilityInput = { controlMode: Object.hasOwn(record(value), 'agentControlMode'), toolPaths: Object.hasOwn(record(value), 'toolPaths'), archiveSessions: Object.hasOwn(record(value), 'archiveSessions') }): WorkerConfigurationValue => {
  const { controlMode: controlModeSupported, toolPaths: toolPathsSupported, archiveSessions: archiveSessionsSupported } = workerConfigurationCapabilities(options);
  const data = fields(value, ['maxConcurrent', 'pollIntervalMs', 'recoveryLimit', 'preferPlatformSpecificTasks', 'native', 'projects', ...(controlModeSupported ? ['agentControlMode'] : []), ...(toolPathsSupported ? ['toolPaths'] : []), ...(archiveSessionsSupported ? ['archiveSessions'] : [])], false, true);
  if (!controlModeSupported && Object.hasOwn(data, 'agentControlMode') || !toolPathsSupported && Object.hasOwn(data, 'toolPaths') || !archiveSessionsSupported && Object.hasOwn(data, 'archiveSessions')) return malformed();
  const projects = array(data.projects, value => {
    const project = fields(value, ['projectId', 'nativeOverrides'], false, true);
    return { projectId: id(project.projectId), nativeOverrides: overrides(project.nativeOverrides) };
  }).sort((a, b) => a.projectId.localeCompare(b.projectId));
  if (new Set(projects.map(project => project.projectId)).size !== projects.length) return malformed();
  return { maxConcurrent: integer(data.maxConcurrent, 1), pollIntervalMs: integer(data.pollIntervalMs, 1, 2_147_483_647), recoveryLimit: integer(data.recoveryLimit, 0), preferPlatformSpecificTasks: boolean(data.preferPlatformSpecificTasks),
    ...(toolPathsSupported ? { toolPaths: parseWorkerCloudToolPaths(knownToolPaths(data.toolPaths)) } : {}),
    ...(archiveSessionsSupported ? { archiveSessions: boolean(data.archiveSessions) } : {}),
    ...(Object.hasOwn(data, 'taskTagFilter') ? { taskTagFilter: parseWorkerTaskTagFilter(data.taskTagFilter) } : {}),
    ...(Object.hasOwn(data, 'enableSudoCleanup') ? { enableSudoCleanup: boolean(data.enableSudoCleanup) } : {}),
    ...(controlModeSupported ? { agentControlMode: data.agentControlMode === null ? null : choice(data.agentControlMode, ['herdr', 'web'] as const) } : {}),
    native: parseConfigurationNative(data.native), projects };
};
const failure = (value: unknown): WorkerConfigurationFailure | null => {
  if (value === null) return null;
  const data = fields(value, ['code', 'category', 'phase', 'occurredAt'], false, true);
  return { code: choice(data.code, ['not_found', 'permission_denied', 'timeout', 'command_failed', 'invalid_output', 'invalid_configuration', 'io_error', 'unavailable']),
    category: choice(data.category, ['validation', 'repository', 'agent', 'runtime', 'storage']), phase: choice(data.phase, ['validate', 'prepare', 'apply', 'stop', 'persist']), occurredAt: configurationTimestamp(data.occurredAt) };
};
const outcome = (value: unknown, controlModeSupported: boolean, archiveSessionsSupported: boolean): WorkerConfigurationOutcome => {
  const data = fields(value, ['key', 'targetRevision', 'appliedValue', 'state', 'error', 'lastFailure', 'nextAttemptAt'], false, true);
  const rawKey = record(data.key);
  const projectKind = rawKey.kind === 'projectPreparation' || rawKey.kind === 'projectRemoval' || rawKey.kind === 'projectNative';
  fields(rawKey, projectKind ? ['kind', 'projectId'] : ['kind'], false, true);
  if (!projectKind && Object.hasOwn(rawKey, 'projectId')) return malformed();
  const key: WorkerConfigurationKey = projectKind
    ? { kind: choice(rawKey.kind, ['projectPreparation', 'projectRemoval', 'projectNative']), projectId: id(rawKey.projectId) }
    : { kind: choice(rawKey.kind, ['maxConcurrent', 'pollIntervalMs', 'recoveryLimit', 'preferPlatformSpecificTasks', 'enableSudoCleanup', 'native', 'taskTagFilter', ...(controlModeSupported ? ['agentControlMode' as const] : []), ...(archiveSessionsSupported ? ['archiveSessions' as const] : [])]) };
  let appliedValue: WorkerConfigurationOutcome['appliedValue'] = null;
  if (data.appliedValue !== null) {
    switch (key.kind) {
      case 'maxConcurrent': appliedValue = integer(data.appliedValue, 1); break;
      case 'pollIntervalMs': appliedValue = integer(data.appliedValue, 1, 2_147_483_647); break;
      case 'recoveryLimit': appliedValue = integer(data.appliedValue, 0); break;
      case 'preferPlatformSpecificTasks': case 'archiveSessions': case 'enableSudoCleanup': appliedValue = boolean(data.appliedValue); break;
      case 'taskTagFilter': if (typeof data.appliedValue !== 'string' || !/^[0-9a-f]{64}$/.test(data.appliedValue)) return malformed(); appliedValue = data.appliedValue; break;
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
export const parseWorkerConfiguration = (value: unknown, options?: WorkerConfigurationCapabilityInput): WorkerConfigurationResource => {
  const source = record(value);
  const desired = source.desired === null || source.desired === undefined ? null : record(source.desired);
  const desiredValue = desired === null ? null : record(desired.value);
  const capabilities = options ?? { controlMode: false, toolPaths: desiredValue !== null && Object.hasOwn(desiredValue, 'toolPaths'), archiveSessions: desiredValue !== null && Object.hasOwn(desiredValue, 'archiveSessions') };
  const { controlMode: controlModeSupported, toolPaths: toolPathsSupported, archiveSessions: archiveSessionsSupported } = workerConfigurationCapabilities(capabilities);
  const data = fields(value, ['desired', 'observationRevision', 'observation'], false, true);
  const observationRevision = parseConfigurationRevision(data.observationRevision, true);
  let target: WorkerConfigurationDesired | null = null, observation: WorkerConfigurationObservation | null = null;
  if (data.desired !== null) {
    const raw = fields(data.desired, ['revision', 'updatedAt', 'value'], false, true);
    // The stored target may predate the current contract. Keep its exact source
    // in the document while projecting only editable fields into the form.
    const stored = record(raw.value);
    const { agentControlMode: _mode, toolPaths: rawTools, ...rest } = stored;
    const projected = { ...rest, ...(toolPathsSupported ? { toolPaths: rawTools === undefined ? { codex: null, copilot: null } : { codex: null, copilot: null, ...record(knownToolPaths(rawTools)) } } : {}) };
    target = { revision: parseConfigurationRevision(raw.revision), updatedAt: configurationTimestamp(raw.updatedAt), value: parseWorkerConfigurationValue(projected, { controlMode: false, toolPaths: toolPathsSupported, archiveSessions: archiveSessionsSupported === true }) };
  }
  if (data.observation !== null) {
    const raw = fields(data.observation, ['baseRevision', 'desiredRevision', 'items', 'reportedAt'], false, true);
    const kinds = ['maxConcurrent', 'pollIntervalMs', 'recoveryLimit', 'preferPlatformSpecificTasks', 'native', 'agentControlMode', 'archiveSessions', 'enableSudoCleanup', 'projectPreparation', 'projectRemoval', 'projectNative', 'taskTagFilter'];
    const desiredRevision = parseConfigurationRevision(raw.desiredRevision);
    const items = array(raw.items, item => {
      const entry = record(item), key = record(entry.key);
      if (typeof key.kind !== 'string') return malformed();
      if (BigInt(parseConfigurationRevision(entry.targetRevision)) > BigInt(desiredRevision)) return malformed();
      if (key.kind === 'agentControlMode' && !controlModeSupported || key.kind === 'archiveSessions' && !archiveSessionsSupported) return malformed();
      return kinds.includes(key.kind) ? outcome(item, controlModeSupported, archiveSessionsSupported === true) : null;
    }).filter((item): item is WorkerConfigurationOutcome => item !== null);
    if (new Set(items.map(item => `${item.key.kind}/${'projectId' in item.key ? item.key.projectId : ''}`)).size !== items.length || items.some(item => BigInt(item.targetRevision) > BigInt(desiredRevision))) return malformed();
    observation = { baseRevision: parseConfigurationRevision(raw.baseRevision, true), desiredRevision, items, reportedAt: configurationTimestamp(raw.reportedAt) };
    if (target === null || BigInt(desiredRevision) > BigInt(target.revision) || BigInt(observation.baseRevision) + 1n !== BigInt(observationRevision)) return malformed();
  }
  if ((observationRevision === '0') !== (observation === null) || target === null && observation !== null) return malformed();
  return { desired: target, observationRevision, observation, ...(controlModeSupported ? { controlModeSupported: true } : {}), ...(toolPathsSupported ? { toolPathsSupported: true } : {}), ...(archiveSessionsSupported ? { archiveSessionsSupported: true } : {}) };
};

export type WorkerConfigurationWriteAdmission = WorkerReadAdmission & { readonly onDispatch?: () => void; readonly onConfirmed?: (resource: WorkerConfigurationResource) => void; readonly onRejected?: (error: ApiError) => void; readonly controlModeSupported?: boolean; readonly toolPathsSupported?: boolean; readonly archiveSessionsSupported?: boolean };
export const workerConfigurationBaseline = (resource: WorkerConfigurationResource): ConfigurationBaseline | null => resource.desired?.document === undefined ? null : configurationBaseline(resource.desired.document);
const rememberDocument = (document: ConfigurationDocument): WorkerConfigurationResource => {
  return { ...document.known, document, desired: document.known.desired === null ? null : { ...document.known.desired, document }, observation: document.known.observation === null ? null : { ...document.known.observation, document } };
};
const decoder = (options: WorkerConfigurationCapabilityInput) => async (response: Response): Promise<unknown> => {
  const source = await response.text();
  return response.ok ? decodeConfigurationDocument(source, data => parseWorkerConfiguration(data, options)) : parseApiJson(source);
};
const url = (workerId: string) => `/api/v1/me/workers/${requestId(workerId)}/configuration`;
export const getWorkerConfiguration = async (workerId: string, signal: AbortSignal, admission: WorkerReadAdmission & { readonly toolPathsSupported?: boolean }): Promise<WorkerConfigurationResource> => {
  const userId = requestId(admission.userId);
  const response = await request(url(workerId), signal, { headers: { Accept: 'application/json', 'Daynight-Worker-Archive-Sessions': '1', 'Daynight-Worker-Tool-Paths': '2' } });
  assertResponsePrincipal(response, userId, admission.onPrincipalMismatch);
  if (response.ok && response.headers.get('Daynight-Worker-Tool-Paths') !== '2') throw new ApiError('protocol', response.status, 'worker_tool_paths_upgrade');
  return json(response, signal, data => {
    if (response.status !== 200 || response.headers.get('Daynight-Worker-Configuration') !== '1') throw new ApiError('protocol', response.status);
    const toolHeader = response.headers.get('Daynight-Worker-Tool-Paths');
    if (toolHeader !== '2') throw new ApiError('protocol', response.status);
    const archiveHeader = response.headers.get('Daynight-Worker-Archive-Sessions');
    if (archiveHeader !== null && archiveHeader !== '1') throw new ApiError('protocol', response.status);
    return rememberDocument(data as ConfigurationDocument);
  }, decoder({ controlMode: false, toolPaths: true, archiveSessions: response.headers.get('Daynight-Worker-Archive-Sessions') === '1' }));
};
export const saveWorkerConfiguration = async (workerId: string, revision: string, value: WorkerConfigurationValue | ConfigurationSubmission, signal: AbortSignal, admission: WorkerConfigurationWriteAdmission): Promise<WorkerConfigurationResource> => {
  const supported = false, toolsSupported = true, archiveSupported = admission.archiveSessionsSupported === true;
  const userId = requestId(admission.userId), expected = parseConfigurationRevision(revision);
  const input = 'valueSource' in value ? value.known : value;
  const projected = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'agentControlMode' && (toolsSupported || key !== "toolPaths") && (archiveSupported || key !== "archiveSessions")));
  const validated = parseWorkerConfigurationValue(projected, { controlMode: supported, toolPaths: toolsSupported, archiveSessions: archiveSupported });
  const submission: ConfigurationSubmission = 'valueSource' in value ? { ...value, valueSource: archiveSupported ? value.valueSource : withoutArchiveSessions(value.valueSource) } : { baseline: { revision: expected, valueSource: JSON.stringify(validated), known: validated }, valueSource: JSON.stringify(validated), known: validated };
  if (submission.baseline.revision !== expected || unsupportedConfigurationFields(submission.valueSource).length > 0) throw new ApiError('protocol');
  const response = await request(url(workerId), signal, { method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Daynight-Worker-Tool-Paths': '2', ...(archiveSupported ? { 'Daynight-Worker-Archive-Sessions': '1' } : {}) }, body: encodeConfigurationPut(submission) }, admission.onDispatch);
  assertResponsePrincipal(response, userId, admission.onPrincipalMismatch);
  if (response.ok && response.headers.get('Daynight-Worker-Tool-Paths') !== '2') throw new ApiError('protocol', response.status, 'worker_tool_paths_upgrade');
  return json(response, signal, data => {
    if (response.status !== 200 || response.headers.get('Daynight-Worker-Configuration') !== '1') throw new ApiError('protocol', response.status);
    const toolHeader = response.headers.get('Daynight-Worker-Tool-Paths');
    if (toolHeader !== '2') throw new ApiError('protocol', response.status);
    const archiveHeader = response.headers.get('Daynight-Worker-Archive-Sessions');
    if (archiveHeader !== null && archiveHeader !== '1' || archiveSupported && archiveHeader !== '1') throw new ApiError('protocol', response.status);
    const resource = rememberDocument(data as ConfigurationDocument), baseline = workerConfigurationBaseline(resource);
    if (resource.desired === null || baseline === null || BigInt(resource.desired.revision) < BigInt(expected) || BigInt(resource.desired.revision) > BigInt(expected) + 1n || !configurationValueSourcesEqual(baseline.valueSource, submission.valueSource, { archiveSessions: archiveSupported, semanticTagFilter: true })) throw new ApiError('protocol', response.status);
    admission.onConfirmed?.(resource);
    return resource;
  }, decoder({ controlMode: false, toolPaths: true, archiveSessions: archiveSupported && response.headers.get('Daynight-Worker-Archive-Sessions') === '1' }), false, admission.onRejected);
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
