import { ApiError, assertResponsePrincipal, json, readAuthRequestGeneration, request, responseSignal, requestId as canonicalRequestId } from './client';
import type { WorkerReadAdmission } from './workers';
import { parseWorkerModelInput, parseWorkerModelResult, type WorkerModelInput, type WorkerModelResult } from './worker-models';
export type { WorkerModelInput, WorkerModelResult, WorkerModelOption, WorkerModelDefault, WorkerModelProvider } from './worker-models';

export const WORKER_READONLY_PROTOCOL = 'daynight.worker-readonly.v1';
export type WorkerDirectoryInput = {
  readonly path?: string;
  readonly filter?: string;
  readonly showHidden?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
};
export type WorkerDirectoryResult = {
  readonly path: string;
  readonly parentPath: string | null;
  readonly entries: readonly { readonly name: string; readonly path: string }[];
  readonly nextCursor: string | null;
};
/** Each operation owns its input and result parser; arbitrary commands are not accepted. */
export type WorkerReadonlyOperations = {
  readonly 'directory.list': { readonly input: WorkerDirectoryInput; readonly result: WorkerDirectoryResult };
  readonly 'model.list': { readonly input: WorkerModelInput; readonly result: WorkerModelResult };
};
export type WorkerReadonlyOperation = keyof WorkerReadonlyOperations;
export type WorkerReadonlyBinding = { readonly connectionId: string; readonly capabilityGeneration: string };
export type WorkerReadonlyResponse<K extends WorkerReadonlyOperation> = WorkerReadonlyBinding & {
  readonly type: 'result';
  readonly protocol: typeof WORKER_READONLY_PROTOCOL;
  readonly ownerUserId: string;
  readonly workerId: string;
  readonly requestId: string;
  readonly result: WorkerReadonlyOperations[K]['result'];
};
const errorCodes = ['offline', 'unsupported', 'permission_denied', 'not_found', 'timeout', 'cancelled', 'invalid_path', 'invalid_cursor', 'io_error', 'busy', 'limit_exceeded', 'invalid_input', 'capability_error', 'cleanup_unknown', 'stale_configuration'] as const;
export type WorkerReadonlyErrorCode = typeof errorCodes[number];
export class WorkerReadonlyError extends Error {
  constructor(readonly code: WorkerReadonlyErrorCode, message: string) { super(message); this.name = 'WorkerReadonlyError'; }
}
export type WorkerReadonlyAdmission = WorkerReadAdmission & {
  /** Return false after replacing the form or target; callers should also abort its signal. */
  readonly isCurrent?: () => boolean;
};
export type WorkerReadonlyRequestOptions = {
  readonly requestId?: string;
  /** Pin further reads to an already observed connection and capability generation. */
  readonly binding?: WorkerReadonlyBinding;
};
const encoder = new TextEncoder();
const malformed = (): never => { throw new ApiError('protocol'); };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : malformed();
const fields = (value: unknown, names: readonly string[], optional = false): Record<string, unknown> => {
  const data = record(value);
  if (Object.keys(data).some(key => !names.includes(key)) || !optional && names.some(key => !Object.hasOwn(data, key))) return malformed();
  return data;
};
const text = (value: unknown, bytes: number, allowEmpty = false): string => {
  if (typeof value !== 'string' || !value.isWellFormed() || /\p{Cc}/u.test(value) || !allowEmpty && value.length === 0 || encoder.encode(value).byteLength > bytes) return malformed();
  return value;
};
const absolutePath = (value: unknown): string => {
  const result = text(value, 4096);
  if (!result.startsWith('/') && !/^[a-z]:[\\/]/i.test(result) && !/^\\\\[^\\/]+[\\/][^\\/]+/.test(result)) return malformed();
  return result;
};
const uuid = (value: unknown): string => typeof value === 'string' ? canonicalRequestId(value) : malformed();
const parseInput = (value: unknown): WorkerDirectoryInput => {
  const data = fields(value, ['path', 'filter', 'showHidden', 'cursor', 'limit'], true);
  if (Object.hasOwn(data, 'path')) absolutePath(data.path);
  if (Object.hasOwn(data, 'filter')) text(data.filter, 256, true);
  if (Object.hasOwn(data, 'cursor')) text(data.cursor, 4096);
  if (Object.hasOwn(data, 'showHidden') && typeof data.showHidden !== 'boolean') return malformed();
  if (Object.hasOwn(data, 'limit') && (typeof data.limit !== 'number' || !Number.isInteger(data.limit) || data.limit < 1 || data.limit > 100)) return malformed();
  return { ...data } as WorkerDirectoryInput;
};
const parseDirectory = (value: unknown): WorkerDirectoryResult => {
  const data = fields(value, ['path', 'parentPath', 'entries', 'nextCursor']);
  if (encoder.encode(JSON.stringify(value)).byteLength > 65_536 || !Array.isArray(data.entries) || data.entries.length > 100) return malformed();
  const path = absolutePath(data.path), windows = /^[a-z]:[\\/]|^\\\\/i.test(path);
  const entries = data.entries.map(value => {
    const item = fields(value, ['name', 'path']), name = text(item.name, 1024);
    if (name === '.' || name === '..' || name.includes('/') || windows && name.includes('\\')) return malformed();
    return { name, path: absolutePath(item.path) };
  });
  if (new Set(entries.map(item => item.name)).size !== entries.length) return malformed();
  return { path, parentPath: data.parentPath === null ? null : absolutePath(data.parentPath), entries, nextCursor: data.nextCursor === null ? null : text(data.nextCursor, 4096) };
};

export const parseWorkerReadonlyResponse = <K extends WorkerReadonlyOperation>(value: unknown, operation: K, expected: {
  readonly ownerUserId: string; readonly workerId: string; readonly requestId: string; readonly binding?: WorkerReadonlyBinding;
}): WorkerReadonlyResponse<K> => {
  const data = record(value), hasResult = Object.hasOwn(data, 'result'), hasError = Object.hasOwn(data, 'error');
  if (hasResult === hasError || operation !== 'directory.list' && operation !== 'model.list') return malformed();
  fields(data, ['type', 'protocol', 'ownerUserId', 'workerId', 'connectionId', 'capabilityGeneration', 'requestId', hasResult ? 'result' : 'error']);
  const ownerUserId = uuid(data.ownerUserId), workerId = uuid(data.workerId), requestId = uuid(data.requestId);
  const connectionId = uuid(data.connectionId), capabilityGeneration = uuid(data.capabilityGeneration);
  if (data.type !== 'result' || data.protocol !== WORKER_READONLY_PROTOCOL || ownerUserId !== uuid(expected.ownerUserId) || workerId !== uuid(expected.workerId) || requestId !== uuid(expected.requestId)
    || expected.binding !== undefined && (connectionId !== uuid(expected.binding.connectionId) || capabilityGeneration !== uuid(expected.binding.capabilityGeneration))) return malformed();
  if (hasError) {
    const error = fields(data.error, ['code', 'message']);
    if (typeof error.code !== 'string' || !errorCodes.includes(error.code as WorkerReadonlyErrorCode)) return malformed();
    throw new WorkerReadonlyError(error.code as WorkerReadonlyErrorCode, text(error.message, 1024));
  }
  const result = operation === 'directory.list' ? parseDirectory(data.result) : parseWorkerModelResult(data.result);
  return { type: 'result', protocol: WORKER_READONLY_PROTOCOL, ownerUserId, workerId, connectionId, capabilityGeneration, requestId, result } as WorkerReadonlyResponse<K>;
};

const boundedJson = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  signal = responseSignal(response, signal);
  signal.throwIfAborted();
  const reader = response.body?.getReader();
  if (reader === undefined) return malformed();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cancelled = false;
  const abort = () => { cancelled = true; void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 256 * 1024) return malformed();
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener('abort', abort);
    if (!cancelled) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

/** Cancellation discards late data; each call is scoped to the current account and target Worker. */
export const requestWorkerReadonly = async <K extends WorkerReadonlyOperation>(worker: string, operation: K, input: WorkerReadonlyOperations[K]['input'], signal: AbortSignal,
  admission: WorkerReadonlyAdmission, options: WorkerReadonlyRequestOptions = {}): Promise<WorkerReadonlyResponse<K>> => {
  const workerId = uuid(worker), ownerUserId = uuid(admission.userId), requestId = uuid(options.requestId ?? crypto.randomUUID());
  if (operation !== 'directory.list' && operation !== 'model.list') return malformed();
  const validatedInput = operation === 'directory.list' ? parseInput(input) : parseWorkerModelInput(input);
  if (options.binding !== undefined) { uuid(options.binding.connectionId); uuid(options.binding.capabilityGeneration); }
  const deadline = new AbortController(), combined = AbortSignal.any([signal, deadline.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined, authGeneration = readAuthRequestGeneration();
  let response: Response | undefined, lifetime = combined;
  const check = (): void => {
    lifetime.throwIfAborted();
    if (readAuthRequestGeneration() !== authGeneration || admission.isCurrent?.() === false) throw new DOMException('The read-only request target changed.', 'AbortError');
  };
  try {
    check();
    response = await request(`/api/v1/me/workers/${workerId}/readonly/requests`, combined, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, operation, input: validatedInput }),
    }, () => {
      authGeneration = readAuthRequestGeneration();
      check();
      timer = setTimeout(() => deadline.abort(new WorkerReadonlyError('timeout', 'The Worker read-only request timed out.')), operation === 'model.list' ? 32_000 : 12_000);
    });
    lifetime = responseSignal(response, combined);
    check();
    assertResponsePrincipal(response, ownerUserId, admission.onPrincipalMismatch);
    const data = await json(response, combined, value => {
      if (response!.status !== 200) return malformed();
      return value;
    }, value => boundedJson(value, combined));
    check();
    const result = parseWorkerReadonlyResponse(data, operation, { ownerUserId, workerId, requestId, ...(options.binding === undefined ? {} : { binding: options.binding }) });
    if (operation === 'model.list' && (result.result as WorkerModelResult).provider !== (validatedInput as WorkerModelInput).provider) return malformed();
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (response?.body !== null && response?.body !== undefined && !response.body.locked) void response.body.cancel().catch(() => undefined);
  }
};

export const browseWorkerDirectory = (workerId: string, input: WorkerDirectoryInput, signal: AbortSignal, admission: WorkerReadonlyAdmission,
  options?: WorkerReadonlyRequestOptions): Promise<WorkerReadonlyResponse<'directory.list'>> => requestWorkerReadonly(workerId, 'directory.list', input, signal, admission, options);

export const discoverWorkerModels = (workerId: string, input: WorkerModelInput, signal: AbortSignal, admission: WorkerReadonlyAdmission,
  options?: WorkerReadonlyRequestOptions): Promise<WorkerReadonlyResponse<'model.list'>> => requestWorkerReadonly(workerId, 'model.list', input, signal, admission, options);
