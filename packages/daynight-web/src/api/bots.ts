import { ApiError, assertResponsePrincipal, json, request, requestId } from './client';
import { array, boolean, executionPlatform, id, malformed, record, string, timestamp } from './validation';
import type { ExecutionPlatform, WorkerAgent } from './types';
import type { WorkerAssistantHost, WorkerMachine, WorkerReadAdmission } from './workers';

export type BotSelectionSource = 'explicit' | 'preference' | 'local' | 'cloud' | 'native' | 'unknown';
export type BotSelection = { readonly schemaVersion: 1; readonly modelSource: BotSelectionSource; readonly reasoningEffortSource: BotSelectionSource; readonly configurationGeneration?: string; readonly catalogGeneration?: string };
export type BotConfiguration = { readonly workerId: string; readonly cwd: string; readonly provider: WorkerAgent; readonly model: string | null; readonly args: readonly string[]; readonly reasoningEffort?: string | null; readonly selection?: BotSelection };
export type BotOverrides = { readonly workerId?: string; readonly cwd?: string; readonly provider?: WorkerAgent; readonly model?: string; readonly reasoningEffort?: string };
export type CreateBotInput = { readonly id: string; readonly name: string; readonly overrides?: BotOverrides };
export type DeleteBotInput = { readonly ifVersion: string; readonly deletionId: string };
export type BotStartupResult = { readonly state: 'pending' | 'ready' | 'failed'; readonly code: string | null };
export type BotCleanupResult = { readonly state: 'pending' | 'completed' | 'failed'; readonly code: string | null };
type BotIdentity = { readonly id: string; readonly workerId: string; readonly version: string };
export type BotDefinition = BotIdentity & {
  readonly deletion: null; readonly ownerUserId: string; readonly name: string; readonly creationOrder: string; readonly attentionCount: number;
  readonly requestedOverrides: BotOverrides; readonly resolvedConfiguration: BotConfiguration;
  readonly roleConfiguration: { readonly instructions: string; readonly revision: string; readonly digest: string } | null;
  readonly sessionId: string | null; readonly testExecutionId: string | null; readonly startupResult: BotStartupResult;
  readonly createdAt: string; readonly updatedAt: string;
};
export type DeletedBot = BotIdentity & { readonly deletion: {
  readonly deletionId: string; readonly requestedVersion: string; readonly workerCleanup: BotCleanupResult; readonly serverCleanup: BotCleanupResult;
} };
export type Bot = BotDefinition | DeletedBot;
export type BotPage = { readonly items: readonly BotDefinition[]; readonly nextCursor: string | null };
export type BotWorkerDefaults = {
  readonly workerId: string; readonly machine: WorkerMachine; readonly platform: ExecutionPlatform;
  readonly state: 'available' | 'offline' | 'unsupported' | 'stale' | 'unavailable';
  readonly reason: string | null; readonly configuration: BotConfiguration | null; readonly providers: WorkerAssistantHost['providers'];
};
export type BotDefaults = { readonly observedAt: string; readonly workerId: string | null; readonly configuration: BotConfiguration | null; readonly reason: string | null; readonly workers: readonly BotWorkerDefaults[] };

const fields = (value: unknown, required: readonly string[], optional: readonly string[] = []) => {
  const data = record(value);
  if (required.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))) return malformed();
  return data;
};
const choice = <T extends string>(value: unknown, choices: readonly T[]): T => typeof value === 'string' && choices.includes(value as T) ? value as T : malformed();
const text = (value: unknown): string => {
  const result = string(value);
  return result.isWellFormed() && /[^\p{White_Space}]/u.test(result) && !result.includes('\0') ? result : malformed();
};
const controlledText = (value: unknown): string => { const result = text(value); return /\p{Cc}/u.test(result) ? malformed() : result; };
const boundedText = (value: unknown, limit: number): string => { const result = controlledText(value); return new TextEncoder().encode(result).length <= limit ? result : malformed(); };
const optionalText = (value: unknown) => value === null ? null : text(value);
const decimal = (value: unknown): string => {
  const result = string(value);
  return /^[1-9][0-9]{0,18}$/.test(result) && BigInt(result) <= 9_223_372_036_854_775_807n ? result : malformed();
};
const attentionCount = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : malformed();
const provider = (value: unknown) => choice(value, ['codex', 'claude', 'copilot']);
const botName = (value: unknown) => {
  const result = controlledText(value).replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  return [...result].length <= 40 ? result : malformed();
};
const absolutePath = (value: unknown): string => {
  const path = controlledText(value);
  return path.startsWith('/') || /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path) ? path : malformed();
};
const argument = (value: unknown): string => {
  const result = string(value);
  return result.isWellFormed() && !result.includes('\0') ? result : malformed();
};
const configuration = (value: unknown): BotConfiguration => {
  const data = fields(value, ['workerId', 'cwd', 'provider', 'model', 'args'], ['reasoningEffort', 'selection']);
  const model = data.model === null ? null : data.selection === undefined ? text(data.model) : boundedText(data.model, 256);
  const reasoningEffort = data.reasoningEffort === undefined ? undefined : data.reasoningEffort === null ? null : boundedText(data.reasoningEffort, 64);
  if ((data.selection === undefined) !== (reasoningEffort === undefined)) return malformed();
  return { workerId: id(data.workerId), cwd: absolutePath(data.cwd), provider: provider(data.provider), model, args: array(data.args, argument), ...(reasoningEffort === undefined ? {} : { reasoningEffort, selection: selection(data.selection, model, reasoningEffort) }) };
};
const selection = (value: unknown, model: string | null, effort: string | null): BotSelection => {
  const data = fields(value, ['schemaVersion', 'modelSource', 'reasoningEffortSource'], ['configurationGeneration', 'catalogGeneration']);
  if (data.schemaVersion !== 1) return malformed();
  const source = (value: unknown, selected: string | null): BotSelectionSource => {
    const parsed = choice(value, ['explicit', 'preference', 'local', 'cloud', 'native', 'unknown']);
    if (parsed === 'unknown' && selected !== null || parsed !== 'native' && parsed !== 'unknown' && selected === null) return malformed();
    return parsed;
  };
  const configurationGeneration = data.configurationGeneration === undefined ? undefined : string(data.configurationGeneration);
  if (configurationGeneration !== undefined && !/^[a-f0-9]{64}$/.test(configurationGeneration)) return malformed();
  return { schemaVersion: 1, modelSource: source(data.modelSource, model), reasoningEffortSource: source(data.reasoningEffortSource, effort), ...(configurationGeneration === undefined ? {} : { configurationGeneration }), ...(data.catalogGeneration === undefined ? {} : { catalogGeneration: id(data.catalogGeneration) }) };
};
const overrides = (value: unknown): BotOverrides => {
  const data = fields(value, [], ['workerId', 'cwd', 'provider', 'model', 'reasoningEffort']);
  return { ...(Object.hasOwn(data, 'workerId') ? { workerId: id(data.workerId) } : {}), ...(Object.hasOwn(data, 'cwd') ? { cwd: absolutePath(data.cwd) } : {}), ...(Object.hasOwn(data, 'provider') ? { provider: provider(data.provider) } : {}), ...(Object.hasOwn(data, 'model') ? { model: boundedText(data.model, 256) } : {}), ...(Object.hasOwn(data, 'reasoningEffort') ? { reasoningEffort: boundedText(data.reasoningEffort, 64) } : {}) };
};
const result = <T extends string>(value: unknown, states: readonly T[]): { readonly state: T; readonly code: string | null } => {
  const data = fields(value, ['state', 'code']), state = choice(data.state, states), code = optionalText(data.code);
  if ((state === 'failed') !== (code !== null)) return malformed();
  return { state, code };
};
const sameConfiguration = (left: BotConfiguration, right: BotConfiguration): boolean => left.workerId === right.workerId && left.cwd === right.cwd && left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort && JSON.stringify(left.selection) === JSON.stringify(right.selection) && left.args.length === right.args.length && left.args.every((arg, index) => arg === right.args[index]);

export const parseBot = (value: unknown, userId: string, expectedId?: string): Bot => {
  const data = record(value), identity = { id: id(data.id), workerId: id(data.workerId), version: decimal(data.version) };
  if (expectedId !== undefined && identity.id !== requestId(expectedId)) return malformed();
  if (data.deletion !== null) {
    fields(data, ['id', 'workerId', 'version', 'deletion']);
    const deletion = fields(data.deletion, ['deletionId', 'requestedVersion', 'workerCleanup', 'serverCleanup']);
    const requestedVersion = decimal(deletion.requestedVersion);
    if (BigInt(requestedVersion) >= BigInt(identity.version)) return malformed();
    return { ...identity, deletion: { deletionId: id(deletion.deletionId), requestedVersion, workerCleanup: result(deletion.workerCleanup, ['pending', 'completed', 'failed']), serverCleanup: result(deletion.serverCleanup, ['pending', 'completed', 'failed']) } };
  }
  fields(data, ['id', 'workerId', 'version', 'deletion', 'ownerUserId', 'name', 'creationOrder', 'attentionCount', 'requestedOverrides', 'resolvedConfiguration', 'roleConfiguration', 'sessionId', 'testExecutionId', 'startupResult', 'createdAt', 'updatedAt']);
  const ownerUserId = id(data.ownerUserId), resolvedConfiguration = configuration(data.resolvedConfiguration), requestedOverrides = overrides(data.requestedOverrides);
  const sessionId = data.sessionId === null ? null : id(data.sessionId), testExecutionId = data.testExecutionId === null ? null : id(data.testExecutionId);
  const startupResult = result(data.startupResult, ['pending', 'ready', 'failed']);
  let roleConfiguration: BotDefinition['roleConfiguration'] = null;
  if (data.roleConfiguration !== null) {
    const role = fields(data.roleConfiguration, ['instructions', 'revision', 'digest']);
    const instructions = text(role.instructions), digest = string(role.digest), revision = text(role.revision);
    if (!instructions.isWellFormed() || instructions.length === 0 || new TextEncoder().encode(instructions).length > 65_536 || !/^[a-f0-9]{64}$/.test(digest)) return malformed();
    roleConfiguration = { instructions, revision, digest };
  }
  if (ownerUserId !== requestId(userId) || identity.workerId !== resolvedConfiguration.workerId || (sessionId === null) !== (testExecutionId === null) || (sessionId === null) !== (roleConfiguration === null) || startupResult.state === 'ready' && sessionId === null) return malformed();
  if (Object.entries(requestedOverrides).some(([key, value]) => resolvedConfiguration[key as keyof BotOverrides] !== value)) return malformed();
  if (requestedOverrides.model !== undefined && resolvedConfiguration.selection?.modelSource !== 'explicit' || requestedOverrides.reasoningEffort !== undefined && resolvedConfiguration.selection?.reasoningEffortSource !== 'explicit') return malformed();
  return { ...identity, deletion: null, ownerUserId, name: botName(data.name), creationOrder: decimal(data.creationOrder), attentionCount: attentionCount(data.attentionCount), requestedOverrides, resolvedConfiguration, roleConfiguration, sessionId, testExecutionId, startupResult, createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
};

const workerDefaults = (value: unknown): BotWorkerDefaults => {
  const data = fields(value, ['workerId', 'machine', 'platform', 'state', 'reason', 'configuration', 'providers']);
  const workerId = id(data.workerId), machine = fields(data.machine, ['id', 'name']), platform = executionPlatform(data.platform);
  const state = choice(data.state, ['available', 'offline', 'unsupported', 'stale', 'unavailable']), reason = optionalText(data.reason);
  const config = data.configuration === null ? null : configuration(data.configuration);
  const providers = array(data.providers, value => {
    const entry = fields(value, ['provider', 'available', 'reason', 'model', 'args']);
    const available = boolean(entry.available), reason = entry.reason === null ? null : choice(entry.reason, ['unsupported_arguments', 'invalid_cwd', 'not_found', 'permission_denied', 'timeout', 'command_failed', 'invalid_output', 'unavailable']);
    const model = entry.model === null ? null : boundedText(entry.model, 256), args = array(entry.args, value => boundedText(value, 4096));
    if (available === (reason !== null) || args.length > 128 || reason === 'unsupported_arguments' && (model !== null || args.length !== 0)) return malformed();
    return { provider: provider(entry.provider), available, reason, model, args };
  });
  if (providers.length !== 0 && providers.length !== 3 || new Set(providers.map(p => p.provider)).size !== providers.length) return malformed();
  if ((config === null) !== (reason !== null) || state !== 'available' && (config !== null || reason !== state) || config !== null && config.workerId !== workerId) return malformed();
  if (config !== null) {
    const cwd = boundedText(config.cwd, 4096), windowsPath = cwd.replaceAll('\\', '/'), unc = windowsPath.startsWith('//') ? windowsPath.slice(2).split('/') : [];
    if (!(platform === 'windows' ? /^[a-z]:\//i.test(windowsPath) || unc.length >= 2 && !!unc[0] && unc[0] !== '.' && unc[0] !== '?' && !!unc[1] : cwd.startsWith('/'))) return malformed();
    const selected = providers.find(p => p.provider === config.provider);
    if (!selected?.available || config.selection === undefined && selected.model !== config.model || selected.args.length !== config.args.length || selected.args.some((arg, index) => arg !== config.args[index])) return malformed();
  }
  return { workerId, machine: { id: id(machine.id), name: text(machine.name) }, platform, state, reason, configuration: config, providers };
};

export const parseBotDefaults = (value: unknown, selectedWorkerId: string | null = null): BotDefaults => {
  const data = fields(value, ['observedAt', 'workerId', 'configuration', 'reason', 'workers']);
  const workerId = data.workerId === null ? null : id(data.workerId), config = data.configuration === null ? null : configuration(data.configuration), reason = optionalText(data.reason);
  const workers = array(data.workers, workerDefaults);
  if (new Set(workers.map(worker => worker.workerId)).size !== workers.length || selectedWorkerId !== null && workerId !== requestId(selectedWorkerId)) return malformed();
  if (workerId === null) {
    if (config !== null || reason !== 'no_available_worker' || workers.some(worker => worker.configuration !== null)) return malformed();
  } else {
    const selected = workers.find(worker => worker.workerId === workerId);
    if (!selected || selected.reason !== reason || (selected.configuration === null) !== (config === null) || config !== null && selected.configuration !== null && !sameConfiguration(selected.configuration, config)) return malformed();
  }
  return { observedAt: timestamp(data.observedAt), workerId, configuration: config, reason, workers };
};

const cursor = (value: unknown): string => {
  const result = controlledText(value);
  return result.length <= 4096 ? result : malformed();
};
async function readBot<T>(url: string, signal: AbortSignal, admission: WorkerReadAdmission, parse: (value: unknown) => T, onDispatch?: () => void, attention = false): Promise<T> {
  const expected = requestId(admission.userId);
  const response = await request(url, signal, { headers: { Accept: 'application/json', ...(attention ? { 'Daynight-Bot-Attention': '1' } : {}) } }, onDispatch);
  assertResponsePrincipal(response, expected, admission.onPrincipalMismatch);
  return json(response, signal, value => { if (response.status !== 200 || attention && response.headers.get('Daynight-Bot-Attention') !== '1') throw new ApiError('protocol', response.status); return parse(value); });
}
export async function listBots(query: { readonly limit?: number; readonly cursor?: string }, signal: AbortSignal, admission: WorkerReadAdmission): Promise<BotPage> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new ApiError('protocol');
    parameters.set('limit', String(query.limit));
  }
  if (query.cursor !== undefined) {
    try { parameters.set('cursor', cursor(query.cursor)); } catch { throw new ApiError('protocol'); }
  }
  return readBot(`/api/v1/me/bots${parameters.size ? `?${parameters}` : ''}`, signal, admission, value => {
    const data = fields(value, ['items', 'nextCursor']);
    const items = array(data.items, entry => { const bot = parseBot(entry, admission.userId); if (bot.deletion !== null) return malformed(); return bot; });
    if (items.length > 100 || new Set(items.map(bot => bot.id)).size !== items.length) return malformed();
    return { items, nextCursor: data.nextCursor === null ? null : cursor(data.nextCursor) };
  }, undefined, true);
}
export async function getBot(botId: string, signal: AbortSignal, admission: WorkerReadAdmission, onDispatch?: () => void): Promise<Bot> {
  const target = requestId(botId);
  return readBot(`/api/v1/me/bots/${target}`, signal, admission, value => parseBot(value, admission.userId, target), onDispatch, true);
}
export async function getBotDefaults(workerId: string | null, signal: AbortSignal, admission: WorkerReadAdmission, choices?: Omit<BotOverrides, 'workerId'>): Promise<BotDefaults> {
  const target = workerId === null ? null : requestId(workerId);
  const query = new URLSearchParams(target === null ? undefined : { workerId: target });
  if (choices !== undefined) {
    let parsed: BotOverrides;
    try { parsed = overrides(choices); if (parsed.workerId !== undefined) throw new ApiError('protocol'); }
    catch { throw new ApiError('protocol'); }
    for (const [key, value] of Object.entries(parsed)) query.set(key, value);
  }
  return readBot(`/api/v1/me/bots/defaults${query.size === 0 ? '' : `?${query}`}`, signal, admission, value => parseBotDefaults(value, target));
}
export class BotCreationUnknown extends Error {
  constructor(readonly id: string, cause: unknown) { super('The Bot creation outcome is unknown.', { cause }); this.name = 'BotCreationUnknown'; }
}
export async function createBot(input: CreateBotInput, signal: AbortSignal, admission: WorkerReadAdmission & { readonly onDispatch?: () => void }): Promise<BotDefinition> {
  const expected = requestId(admission.userId), target = requestId(input.id);
  let body: string;
  try { body = JSON.stringify({ id: target, name: botName(input.name), ...(input.overrides === undefined ? {} : { overrides: overrides(input.overrides) }) }); }
  catch { throw new ApiError('protocol'); }
  let dispatched = false;
  try {
    const response = await request('/api/v1/me/bots', signal, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Daynight-Bot-Attention': '1' }, body }, () => { dispatched = true; admission.onDispatch?.(); });
    assertResponsePrincipal(response, expected, admission.onPrincipalMismatch);
    return await json(response, signal, value => {
      if (response.status !== 200 || response.headers.get('Daynight-Bot-Attention') !== '1') throw new ApiError('protocol', response.status);
      const bot = parseBot(value, expected, target);
      if (bot.deletion !== null) return malformed();
      const original = JSON.parse(body) as CreateBotInput;
      if (bot.name !== original.name || JSON.stringify(bot.requestedOverrides) !== JSON.stringify(overrides(original.overrides ?? {}))) return malformed();
      return bot;
    });
  } catch (error) {
    // A dispatched write is observed by its original ID, including malformed
    // responses and aborted reads; neither error proves that creation rolled back.
    if (dispatched && !(error instanceof ApiError && error.kind === 'server' && error.status !== null && error.status >= 400 && error.status < 500)) throw new BotCreationUnknown(target, error);
    throw error;
  }
}

export class BotDeletionUnknown extends Error {
  constructor(readonly id: string, readonly input: DeleteBotInput, cause: unknown) { super('The Bot deletion outcome is unknown.', { cause }); this.name = 'BotDeletionUnknown'; }
}

/** Submit one exact deletion request; callers observe the Bot before deciding whether to retry it. */
export async function deleteBot(botId: string, input: DeleteBotInput, signal: AbortSignal, admission: WorkerReadAdmission, onDispatch?: () => void): Promise<DeletedBot> {
  const expected = requestId(admission.userId), target = requestId(botId);
  let original: DeleteBotInput;
  try { original = Object.freeze({ ifVersion: decimal(input.ifVersion), deletionId: requestId(input.deletionId) }); }
  catch { throw new ApiError('protocol'); }
  let dispatched = false;
  try {
    const response = await request(`/api/v1/me/bots/${target}`, signal, { method: 'DELETE', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(original) }, () => { dispatched = true; onDispatch?.(); });
    assertResponsePrincipal(response, expected, admission.onPrincipalMismatch);
    return await json(response, signal, value => {
      if (response.status !== 200) throw new ApiError('protocol', response.status);
      const bot = parseBot(value, expected, target);
      if (bot.deletion === null || bot.deletion.deletionId !== original.deletionId || bot.deletion.requestedVersion !== original.ifVersion) return malformed();
      return bot;
    });
  } catch (error) {
    // A later GET may precede a still-running DELETE commit. Preserve its
    // original identity until observation resolves the result; never replay here.
    if (dispatched && !(error instanceof ApiError && error.kind === 'server' && error.status !== null && error.status >= 400 && error.status < 500)) throw new BotDeletionUnknown(target, original, error);
    throw error;
  }
}

/** Mark the currently outstanding report events as seen; proposal decisions remain independent. */
export async function markBotAttentionSeen(botId: string, signal: AbortSignal, admission: WorkerReadAdmission, onDispatch?: () => void): Promise<void> {
  const expected = requestId(admission.userId), target = requestId(botId);
  const response = await request(`/api/v1/bots/${target}/attention/seen`, signal, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}' }, onDispatch);
  assertResponsePrincipal(response, expected, admission.onPrincipalMismatch);
  await json(response, signal, value => {
    if (response.status !== 200 || id(fields(value, ['targetBotId']).targetBotId) !== target) return malformed();
  });
}
