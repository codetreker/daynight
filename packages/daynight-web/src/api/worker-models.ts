import { ApiError, requestId } from './client';

export type WorkerModelProvider = 'codex' | 'claude' | 'copilot';
export type WorkerModelInput = {
  readonly provider: WorkerModelProvider;
  readonly cwd?: string;
  readonly model?: string;
  readonly includeHidden?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
};
export type WorkerModelOption = {
  readonly id: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly hidden: boolean;
  readonly reasoningEfforts: readonly string[] | null;
  readonly defaultReasoningEffort: string | null;
};
export type WorkerModelDefault = {
  readonly value: string | null;
  readonly source: 'explicit' | 'local' | 'cloud' | 'native' | 'unknown';
};
export type WorkerModelResult = {
  readonly schemaVersion: 1;
  readonly provider: WorkerModelProvider;
  readonly cwd: string;
  readonly configurationGeneration: string;
  readonly catalogGeneration: string;
  readonly models: readonly WorkerModelOption[];
  readonly defaults: { readonly model: WorkerModelDefault; readonly reasoningEffort: WorkerModelDefault };
  readonly selectionError: { readonly code: 'unknown_default' | 'unsupported_selection'; readonly message: string } | null;
  readonly nextCursor: string | null;
};

const encoder = new TextEncoder();
const malformed = (): never => { throw new ApiError('protocol'); };
const fields = (value: unknown, keys: readonly string[], optional = false): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return malformed();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !keys.includes(key)) || !optional && keys.some(key => !Object.hasOwn(data, key))) return malformed();
  return data;
};
const text = (value: unknown, limit: number): string => {
  if (typeof value !== 'string' || !value.isWellFormed() || value.trim() === '' || /\p{Cc}/u.test(value) || encoder.encode(value).byteLength > limit) return malformed();
  return value;
};
const path = (value: unknown): string => {
  const result = text(value, 4096);
  if (!result.startsWith('/') && !/^[a-z]:[\\/]/i.test(result) && !/^\\\\[^\\/]+[\\/][^\\/]+/.test(result)) return malformed();
  return result;
};
const provider = (value: unknown): WorkerModelProvider => value === 'codex' || value === 'claude' || value === 'copilot' ? value : malformed();
const strings = (value: unknown, count: number, bytes: number): string[] => {
  if (!Array.isArray(value) || value.length > count) return malformed();
  const result = value.map(item => text(item, bytes));
  return new Set(result).size === result.length ? result : malformed();
};
const nullableText = (value: unknown, limit: number): string | null => value === null ? null : text(value, limit);

export const parseWorkerModelInput = (value: unknown): WorkerModelInput => {
  const data = fields(value, ['provider', 'cwd', 'model', 'includeHidden', 'limit', 'cursor'], true);
  provider(data.provider);
  if (Object.hasOwn(data, 'cwd')) path(data.cwd);
  if (Object.hasOwn(data, 'model')) text(data.model, 256);
  if (Object.hasOwn(data, 'cursor')) text(data.cursor, 4096);
  if (Object.hasOwn(data, 'includeHidden') && typeof data.includeHidden !== 'boolean') return malformed();
  if (Object.hasOwn(data, 'limit') && (typeof data.limit !== 'number' || !Number.isInteger(data.limit) || data.limit < 1 || data.limit > 100)) return malformed();
  return { ...data } as WorkerModelInput;
};

const parseDefault = (value: unknown, bytes: number): WorkerModelDefault => {
  const data = fields(value, ['value', 'source']);
  const selected = nullableText(data.value, bytes);
  if (data.source !== 'explicit' && data.source !== 'local' && data.source !== 'cloud' && data.source !== 'native' && data.source !== 'unknown') return malformed();
  if (data.source === 'unknown' && selected !== null || data.source !== 'native' && data.source !== 'unknown' && selected === null) return malformed();
  return { value: selected, source: data.source };
};
const parseModel = (value: unknown): WorkerModelOption => {
  const data = fields(value, ['id', 'label', 'aliases', 'hidden', 'reasoningEfforts', 'defaultReasoningEffort']);
  if (typeof data.hidden !== 'boolean') return malformed();
  const reasoningEfforts = data.reasoningEfforts === null ? null : strings(data.reasoningEfforts, 32, 64);
  const defaultReasoningEffort = nullableText(data.defaultReasoningEffort, 64);
  if (defaultReasoningEffort !== null && !reasoningEfforts?.includes(defaultReasoningEffort)) return malformed();
  return { id: text(data.id, 256), label: text(data.label, 1024), aliases: strings(data.aliases, 16, 256), hidden: data.hidden, reasoningEfforts, defaultReasoningEffort };
};

export const parseWorkerModelResult = (value: unknown): WorkerModelResult => {
  const data = fields(value, ['schemaVersion', 'provider', 'cwd', 'configurationGeneration', 'catalogGeneration', 'models', 'defaults', 'selectionError', 'nextCursor']);
  if (data.schemaVersion !== 1 || typeof data.configurationGeneration !== 'string' || !/^[0-9a-f]{64}$/.test(data.configurationGeneration)
    || typeof data.catalogGeneration !== 'string' || !Array.isArray(data.models) || data.models.length > 100 || encoder.encode(JSON.stringify(value)).byteLength > 65_536) return malformed();
  const models = data.models.map(parseModel);
  if (new Set(models.map(model => model.id)).size !== models.length) return malformed();
  const defaults = fields(data.defaults, ['model', 'reasoningEffort']);
  let selectionError: WorkerModelResult['selectionError'] = null;
  if (data.selectionError !== null) {
    const error = fields(data.selectionError, ['code', 'message']);
    if (error.code !== 'unknown_default' && error.code !== 'unsupported_selection') return malformed();
    selectionError = { code: error.code, message: text(error.message, 1024) };
  }
  return { schemaVersion: 1, provider: provider(data.provider), cwd: path(data.cwd), configurationGeneration: data.configurationGeneration,
    catalogGeneration: requestId(data.catalogGeneration), models, defaults: { model: parseDefault(defaults.model, 256), reasoningEffort: parseDefault(defaults.reasoningEffort, 64) }, selectionError,
    nextCursor: nullableText(data.nextCursor, 4096) };
};
