import { ApiError, assertResponsePrincipal, json, request, requestId } from './client';
import { id, malformed, record } from './parse';
import { parseConfigurationRevision } from './worker-configuration';
import type { WorkerReadAdmission } from './workers';

export const WORKER_ALIAS_HEADER = 'Daynight-Worker-Alias';
export type WorkerAlias = { readonly value: string | null; readonly version: string };
const forbidden = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;

export const normalizeWorkerAlias = (value: string): string | null => {
  const normalized = value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  return value.isWellFormed() && !forbidden.test(value) && normalized.length > 0 && [...normalized].length <= 80 ? normalized : null;
};

export const parseWorkerAlias = (value: unknown): WorkerAlias => {
  const data = record(value);
  if (Object.keys(data).length !== 2 || !Object.hasOwn(data, 'value') || !Object.hasOwn(data, 'version')
    || data.value !== null && (typeof data.value !== 'string' || normalizeWorkerAlias(data.value) !== data.value)) return malformed();
  return { value: data.value, version: parseConfigurationRevision(data.version) };
};

const aliasRequest = async (worker: string, signal: AbortSignal, admission: WorkerReadAdmission, input?: { readonly value: string | null; readonly expectedVersion: string },
  onDispatch?: () => void): Promise<WorkerAlias> => {
  const workerId = requestId(worker), userId = requestId(admission.userId);
  if (input !== undefined) {
    parseConfigurationRevision(input.expectedVersion);
    if (input.value !== null && normalizeWorkerAlias(input.value) !== input.value) throw new ApiError('protocol');
  }
  const response = await request(`/api/v1/me/workers/${workerId}/alias`, signal, {
    method: input === undefined ? 'GET' : 'PUT',
    headers: { Accept: 'application/json', ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }, onDispatch);
  assertResponsePrincipal(response, userId, admission.onPrincipalMismatch);
  return json(response, signal, value => {
    if (response.status !== 200) return malformed();
    const data = record(value);
    if (Object.keys(data).length !== 2 || id(data.workerId) !== workerId || !Object.hasOwn(data, 'alias')) return malformed();
    const alias = parseWorkerAlias(data.alias);
    if (input !== undefined && (alias.value !== input.value || BigInt(alias.version) < BigInt(input.expectedVersion)
      || BigInt(alias.version) > BigInt(input.expectedVersion) + 1n)) return malformed();
    return alias;
  });
};

export const getWorkerAlias = (workerId: string, signal: AbortSignal, admission: WorkerReadAdmission): Promise<WorkerAlias> => aliasRequest(workerId, signal, admission);
export const saveWorkerAlias = (workerId: string, value: string | null, expectedVersion: string, signal: AbortSignal, admission: WorkerReadAdmission,
  onDispatch: () => void): Promise<WorkerAlias> => aliasRequest(workerId, signal, admission, { value, expectedVersion }, onDispatch);
