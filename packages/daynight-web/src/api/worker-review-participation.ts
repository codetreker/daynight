import { ApiError, assertResponsePrincipal, json, request, requestId } from './client';
import { malformed, record } from './parse';
import { parseConfigurationRevision } from './worker-configuration';
import type { WorkerReadAdmission } from './workers';

export type WorkerReviewParticipation = { readonly enabled: boolean; readonly version: string };

const participationRequest = async (worker: string, signal: AbortSignal, admission: WorkerReadAdmission,
  input?: { readonly enabled: boolean; readonly expectedVersion: string }, onDispatch?: () => void): Promise<WorkerReviewParticipation> => {
  const workerId = requestId(worker), userId = requestId(admission.userId);
  if (input !== undefined) parseConfigurationRevision(input.expectedVersion);
  const response = await request(`/api/v1/me/workers/${workerId}/review-participation`, signal, {
    method: input === undefined ? 'GET' : 'PUT',
    headers: { Accept: 'application/json', ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }, onDispatch);
  // Older services may return a router-level 404 without identity headers.
  if (response.status === 404 && response.headers.get('Daynight-User-ID') === null) throw new ApiError('server', 404, 'not_found');
  assertResponsePrincipal(response, userId, admission.onPrincipalMismatch);
  return json(response, signal, value => {
    if (response.status !== 200) return malformed();
    const data = record(value);
    if (Object.keys(data).length !== 2 || typeof data.enabled !== 'boolean' || !Object.hasOwn(data, 'version')) return malformed();
    const result = { enabled: data.enabled, version: parseConfigurationRevision(data.version) };
    if (input !== undefined && (result.enabled !== input.enabled || BigInt(result.version) !== BigInt(input.expectedVersion) + 1n)) return malformed();
    return result;
  });
};

export const getWorkerReviewParticipation = (workerId: string, signal: AbortSignal, admission: WorkerReadAdmission) => participationRequest(workerId, signal, admission);
export const saveWorkerReviewParticipation = (workerId: string, enabled: boolean, expectedVersion: string, signal: AbortSignal, admission: WorkerReadAdmission, onDispatch: () => void) =>
  participationRequest(workerId, signal, admission, { enabled, expectedVersion }, onDispatch);
