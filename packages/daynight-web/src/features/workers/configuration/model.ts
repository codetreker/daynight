import { isConfigurationText, parseWorkerConfigurationValue, type WorkerConfigurationNative, type WorkerConfigurationOverrides, type WorkerConfigurationResource, type WorkerConfigurationValue } from '../../../api/worker-configuration';
import { canonicalId } from '../../../api/parse';
import type { ExecutionPlatform, WorkerAgent } from '../../../api/types';
import { parseToolPathChoice, type Tool, type WorkerCloudToolPaths } from '../../../api/worker-tool-paths';
import { parseWorkerTaskTagFilter, taskTagFilterSemantics, type WorkerTaskTagFilter } from '../../../api/worker-task-tag-filter';
import { normalizeTagName } from '../../../api/task-tags';

export type NativeDraft = { readonly agent: WorkerAgent; readonly model: string; readonly args: string };
export type ProjectNativeDraft = {
  readonly agent: WorkerAgent | 'inherit'; readonly modelMode: 'inherit' | 'default' | 'custom'; readonly model: string;
  readonly argsMode: 'inherit' | 'clear' | 'custom'; readonly args: string;
};
export type ConfigurationDraft = {
  readonly maxConcurrent: string; readonly pollIntervalMs: string; readonly recoveryLimit: string; readonly preferPlatformSpecificTasks: boolean; readonly native: NativeDraft;
  readonly agentControlMode?: WorkerConfigurationValue['agentControlMode'];
  readonly archiveSessions?: boolean;
  readonly enableSudoCleanup?: boolean | undefined;
  readonly toolPaths?: WorkerCloudToolPaths;
  readonly taskTagFilter?: WorkerTaskTagFilter & { readonly input: string };
  readonly projects: readonly { readonly projectId: string; readonly native: ProjectNativeDraft }[];
};
export type DraftIssue = 'integer' | 'model' | 'args' | 'agent' | 'project' | 'controlMode' | 'toolPath' | 'tagName';
export type ParsedConfigurationDraft = { readonly value: WorkerConfigurationValue | null; readonly errors: Readonly<Record<string, DraftIssue>> };
export type ConfigurationDraftOptions = { readonly toolPathsSupported?: boolean; readonly archiveSessionsSupported?: boolean; readonly platform?: ExecutionPlatform };
const agents: readonly string[] = ['codex', 'claude', 'copilot'];
const tools: readonly Tool[] = ['codex', 'copilot'];
export const emptyProjectDraft = (projectId: string): ConfigurationDraft['projects'][number] => ({ projectId, native: { agent: 'inherit', modelMode: 'inherit', model: '', argsMode: 'inherit', args: '[]' } });
export const draftFromValue = (value: WorkerConfigurationValue): ConfigurationDraft => ({
  maxConcurrent: String(value.maxConcurrent), pollIntervalMs: String(value.pollIntervalMs), recoveryLimit: String(value.recoveryLimit), preferPlatformSpecificTasks: value.preferPlatformSpecificTasks,

  ...(value.archiveSessions === undefined ? {} : { archiveSessions: value.archiveSessions }),
  ...(value.enableSudoCleanup === undefined ? {} : { enableSudoCleanup: value.enableSudoCleanup }),
  ...(value.toolPaths === undefined ? {} : { toolPaths: structuredClone(value.toolPaths) }),
  ...(value.taskTagFilter === undefined ? {} : { taskTagFilter: { ...value.taskTagFilter, names: [...value.taskTagFilter.names], input: '' } }),
  native: { agent: value.native.agent, model: value.native.model === null ? '' : value.native.model, args: JSON.stringify(value.native.args) },
  projects: value.projects.map(project => ({ projectId: project.projectId, native: {
    agent: project.nativeOverrides.agent === undefined ? 'inherit' : project.nativeOverrides.agent,
    modelMode: !Object.hasOwn(project.nativeOverrides, 'model') ? 'inherit' : project.nativeOverrides.model === null ? 'default' : 'custom',
    model: typeof project.nativeOverrides.model === 'string' ? project.nativeOverrides.model : '',
    argsMode: !Object.hasOwn(project.nativeOverrides, 'args') ? 'inherit' : project.nativeOverrides.args!.length === 0 ? 'clear' : 'custom',
    args: JSON.stringify(project.nativeOverrides.args === undefined ? [] : project.nativeOverrides.args),
  } })),
});
export const parseConfigurationDraft = (draft: ConfigurationDraft, controlModeSupported = draft.agentControlMode !== undefined, options: ConfigurationDraftOptions = {}): ParsedConfigurationDraft => {
  const errors: Record<string, DraftIssue> = {};
  let taskTagFilter: WorkerTaskTagFilter | undefined;
  if (draft.taskTagFilter !== undefined) {
    const { names, match, input } = draft.taskTagFilter;
    const pending = input.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
    if (pending !== '' && normalizeTagName(input) === null) errors.taskTagFilter = 'tagName';
    try { taskTagFilter = parseWorkerTaskTagFilter({ names: pending === '' ? names : [...names, input], match }); }
    catch { errors.taskTagFilter = 'tagName'; }
  }
  const toolPathsSupported = options.toolPathsSupported ?? draft.toolPaths !== undefined;
  const archiveSessionsSupported = options.archiveSessionsSupported ?? draft.archiveSessions !== undefined;
  if (toolPathsSupported) for (const tool of tools) {
    const choice = draft.toolPaths?.[tool];
    if (choice === null) continue;
    try { parseToolPathChoice(choice, options.platform); }
    catch { errors[`toolPaths.${tool}`] = 'toolPath'; }
  }
  const number = (raw: string, key: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number => {
    const value = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) errors[key] = 'integer';
    return value;
  };
  const model = (raw: string, key: string, nullable: boolean): string | null => {
    if (nullable && raw === '') return null;
    if (!isConfigurationText(raw)) errors[key] = 'model';
    return raw;
  };
  const args = (raw: string, key: string): readonly string[] => {
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { errors[key] = 'args'; return []; }
    if (!Array.isArray(value) || !value.every(isConfigurationText)) { errors[key] = 'args'; return []; }
    return value as string[];
  };
  const maxConcurrent = number(draft.maxConcurrent, 'maxConcurrent', 1), pollIntervalMs = number(draft.pollIntervalMs, 'pollIntervalMs', 1, 2_147_483_647), recoveryLimit = number(draft.recoveryLimit, 'recoveryLimit', 0);
  if (!agents.includes(draft.native.agent)) errors['native.agent'] = 'agent';
  if (controlModeSupported && draft.agentControlMode !== null && draft.agentControlMode !== 'herdr' && draft.agentControlMode !== 'web') errors.agentControlMode = 'controlMode';
  const native: WorkerConfigurationNative = { agent: draft.native.agent, model: model(draft.native.model, 'native.model', true), args: args(draft.native.args, 'native.args') };
  const seen = new Set<string>();
  const projects = draft.projects.map(project => {
    const key = `projects.${project.projectId}`, identifier = canonicalId(project.projectId);
    if (identifier === null || seen.has(identifier)) errors[`${key}.projectId`] = 'project';
    else seen.add(identifier);
    const source = project.native;
    if (source.agent !== 'inherit' && !agents.includes(source.agent)) errors[`${key}.agent`] = 'agent';
    const nativeOverrides: WorkerConfigurationOverrides = {
      ...(source.agent === 'inherit' ? {} : { agent: source.agent }),
      ...(source.modelMode === 'inherit' ? {} : { model: source.modelMode === 'default' ? null : model(source.model, `${key}.model`, false) }),
      ...(source.argsMode === 'inherit' ? {} : { args: source.argsMode === 'clear' ? [] : args(source.args, `${key}.args`) }),
    };
    return { projectId: project.projectId, nativeOverrides };
  });
  return { value: Object.keys(errors).length === 0 ? parseWorkerConfigurationValue({ maxConcurrent, pollIntervalMs, recoveryLimit, preferPlatformSpecificTasks: draft.preferPlatformSpecificTasks,
    ...(controlModeSupported ? { agentControlMode: draft.agentControlMode } : {}), ...(toolPathsSupported ? { toolPaths: draft.toolPaths } : {}), ...(archiveSessionsSupported ? { archiveSessions: draft.archiveSessions } : {}), ...(draft.enableSudoCleanup === undefined ? {} : { enableSudoCleanup: draft.enableSudoCleanup }), ...(taskTagFilter === undefined ? {} : { taskTagFilter }), native, projects }) : null, errors };
};
const filterKey = (filter: ConfigurationDraft['taskTagFilter']): string | undefined => {
  if (filter === undefined) return undefined;
  const pending = filter.input.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  try { return taskTagFilterSemantics({ names: pending === '' ? filter.names : [...filter.names, filter.input], match: filter.match }); }
  catch { return JSON.stringify(filter); }
};
const projectedFields = <T extends { readonly agentControlMode?: WorkerConfigurationValue['agentControlMode']; readonly toolPaths?: WorkerCloudToolPaths; readonly archiveSessions?: boolean; readonly enableSudoCleanup?: boolean | undefined }>(source: T, includeControlMode: boolean, includeToolPaths: boolean, includeArchiveSessions: boolean, includeSudoCleanup: boolean) => {
  const { agentControlMode, toolPaths, archiveSessions, enableSudoCleanup, ...rest } = source;
  return { ...rest, ...(includeControlMode && agentControlMode !== undefined ? { agentControlMode } : {}), ...(includeToolPaths && toolPaths !== undefined ? { toolPaths } : {}), ...(includeArchiveSessions && archiveSessions !== undefined ? { archiveSessions } : {}), ...(includeSudoCleanup && enableSudoCleanup !== undefined ? { enableSudoCleanup } : {}) };
};
export const configurationValuesEqual = (left: WorkerConfigurationValue, right: WorkerConfigurationValue, includeControlMode = true, includeToolPaths = true, includeArchiveSessions = true, includeSudoCleanup = true): boolean => {
  const a = parseWorkerConfigurationValue(projectedFields(left, includeControlMode, includeToolPaths, includeArchiveSessions, includeSudoCleanup));
  const b = parseWorkerConfigurationValue(projectedFields(right, includeControlMode, includeToolPaths, includeArchiveSessions, includeSudoCleanup));
  const { taskTagFilter: af, ...ar } = a, { taskTagFilter: bf, ...br } = b;
  return JSON.stringify(ar) === JSON.stringify(br) && (af === undefined ? bf === undefined : bf !== undefined && taskTagFilterSemantics(af) === taskTagFilterSemantics(bf));
};
export const configurationDraftsEqual = (left: ConfigurationDraft, right: ConfigurationDraft, includeControlMode = true, includeToolPaths = true, includeArchiveSessions = true, includeSudoCleanup = true): boolean => {
  const { taskTagFilter: af, ...ar } = projectedFields(left, includeControlMode, includeToolPaths, includeArchiveSessions, includeSudoCleanup);
  const { taskTagFilter: bf, ...br } = projectedFields(right, includeControlMode, includeToolPaths, includeArchiveSessions, includeSudoCleanup);
  return JSON.stringify(ar) === JSON.stringify(br) && filterKey(af) === filterKey(bf);
};
export const configurationFieldChanges = (draft: ConfigurationDraft, desired: WorkerConfigurationValue, errors: ParsedConfigurationDraft['errors']) => {
  // Isolate each native tuple so an unrelated invalid field cannot hide its saved state.
  const baseline = { ...draftFromValue(desired), projects: [] };
  const native = parseConfigurationDraft({ ...baseline, native: draft.native }, undefined, { toolPathsSupported: false }).value?.native;
  const projects = new Map(desired.projects.map(project => [project.projectId, project.nativeOverrides]));
  return {
    maxConcurrent: errors.maxConcurrent !== undefined || Number(draft.maxConcurrent) !== desired.maxConcurrent,
    pollIntervalMs: errors.pollIntervalMs !== undefined || Number(draft.pollIntervalMs) !== desired.pollIntervalMs,
    recoveryLimit: errors.recoveryLimit !== undefined || Number(draft.recoveryLimit) !== desired.recoveryLimit,
    preferPlatformSpecificTasks: draft.preferPlatformSpecificTasks !== desired.preferPlatformSpecificTasks,
    archiveSessions: draft.archiveSessions !== desired.archiveSessions,
    enableSudoCleanup: draft.enableSudoCleanup !== desired.enableSudoCleanup,
    agentControlMode: errors.agentControlMode !== undefined || draft.agentControlMode !== desired.agentControlMode,
    taskTagFilter: errors.taskTagFilter !== undefined || filterKey(draft.taskTagFilter) !== filterKey(desired.taskTagFilter === undefined ? undefined : { ...desired.taskTagFilter, input: '' }),
    toolPaths: Object.fromEntries(tools.map(tool => [tool, errors[`toolPaths.${tool}`] !== undefined || JSON.stringify(draft.toolPaths?.[tool]) !== JSON.stringify(desired.toolPaths?.[tool])])) as Readonly<Record<Tool, boolean>>,
    native: native === undefined || JSON.stringify(native) !== JSON.stringify(desired.native),
    projects: new Map(draft.projects.map(project => {
      const expected = projects.get(project.projectId);
      const overrides = parseConfigurationDraft({ ...baseline, projects: [project] }, undefined, { toolPathsSupported: false }).value?.projects[0]?.nativeOverrides;
      return [project.projectId, expected === undefined || overrides === undefined || JSON.stringify(overrides) !== JSON.stringify(expected)];
    })),
  };
};
export const resolvedProjectNative = (global: WorkerConfigurationNative, overrides: WorkerConfigurationOverrides): WorkerConfigurationNative => {
  const sameAgent = overrides.agent === undefined || overrides.agent === global.agent;
  return { agent: overrides.agent === undefined ? global.agent : overrides.agent,
    model: Object.hasOwn(overrides, 'model') ? overrides.model! : sameAgent ? global.model : null,
    args: Object.hasOwn(overrides, 'args') ? overrides.args! : sameAgent ? global.args : [],
  };
};
export const mergeConfigurationResources = (current: WorkerConfigurationResource | null, incoming: WorkerConfigurationResource): WorkerConfigurationResource => {
  if (current === null) return incoming;
  const currentValue = current.desired?.value, incomingValue = incoming.desired?.value;
  const currentHasMore = current.desired?.revision === incoming.desired?.revision && currentValue !== undefined && incomingValue !== undefined &&
    (incomingValue.agentControlMode === undefined || currentValue.agentControlMode !== undefined) && (incomingValue.toolPaths === undefined || currentValue.toolPaths !== undefined) && (incomingValue.archiveSessions === undefined || currentValue.archiveSessions !== undefined) &&
    (currentValue.agentControlMode !== undefined && incomingValue.agentControlMode === undefined || currentValue.toolPaths !== undefined && incomingValue.toolPaths === undefined || currentValue.archiveSessions !== undefined && incomingValue.archiveSessions === undefined);
  const desired = current.desired !== null && (incoming.desired === null || BigInt(current.desired.revision) > BigInt(incoming.desired.revision) || currentHasMore) ? current.desired : incoming.desired;
  const observation = BigInt(current.observationRevision) > BigInt(incoming.observationRevision) ? current : incoming;
  return { desired, observationRevision: observation.observationRevision, observation: observation.observation, ...(incoming.document === undefined ? {} : { document: incoming.document }), ...(incoming.controlModeSupported === true ? { controlModeSupported: true } : {}), ...(incoming.toolPathsSupported === true ? { toolPathsSupported: true } : {}), ...(incoming.archiveSessionsSupported === true ? { archiveSessionsSupported: true } : {}) };
};
