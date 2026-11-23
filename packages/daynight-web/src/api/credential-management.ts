import { parseUser } from './auth-parse';
import { ApiError, assertResponsePrincipal, isAbortError, json, readAuthRequestGeneration, request, requestId, responseSignal } from './client';
import { normalizeCredentialDescription, parseCredentialDescription, type CredentialDescriptionReceipt, type CredentialDescriptionUpdate } from './credential-description';
import { id, malformed, record } from './parse';

const responseGenerations = new WeakMap<Response, number>();

const assertGeneration = (generation: number, signal: AbortSignal): void => {
  signal.throwIfAborted();
  if (generation !== readAuthRequestGeneration()) throw new DOMException('The authenticated account changed.', 'AbortError');
};

export const credentialOperation = async <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
  try { return await operation(); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof ApiError && !isAbortError(error)) throw new ApiError(error.kind, error.status, error.code, error.requestId, undefined, undefined, error.writeOutcome);
    throw error;
  }
};

export const credentialRequest = async (url: string, signal: AbortSignal, expectedUserId: string, onIdentityMismatch: () => void, init: RequestInit = {}, onDispatch?: () => void): Promise<Response> => {
  const expected = requestId(expectedUserId), generation = readAuthRequestGeneration();
  const response = await request(url, signal, init, onDispatch, undefined, { deferUnauthorized: true });
  assertGeneration(generation, signal);
  if (response.status === 401) {
    const verification = await request('/api/v1/me', signal, { cache: 'no-cache', headers: { Accept: 'application/json' } });
    assertGeneration(generation, signal);
    if (verification.status === 401) throw new ApiError('server', 401, 'unauthenticated');
    const user = await json(verification, signal, value => {
      if (verification.status !== 200) return malformed();
      return parseUser(value);
    });
    assertGeneration(generation, signal);
    if (user.id !== expected) {
      onIdentityMismatch();
      throw new ApiError('protocol', 401, 'principal_mismatch');
    }
    throw new ApiError('protocol', 401, 'credential_interface_unavailable');
  }
  assertResponsePrincipal(response, expected, onIdentityMismatch);
  responseGenerations.set(response, generation);
  return response;
};

export const credentialJson = async <T>(response: Response, signal: AbortSignal, parse: (value: unknown) => T): Promise<T> => {
  const generation = responseGenerations.get(response);
  if (generation === undefined) throw new ApiError('protocol', response.status);
  assertGeneration(generation, signal);
  const result = await json(response, signal, parse);
  responseSignal(response, signal).throwIfAborted();
  assertGeneration(generation, signal);
  return result;
};

export const updateCredentialDescription = (url: string, targetId: string, input: CredentialDescriptionUpdate, signal: AbortSignal, onIdentityMismatch: () => void, onDispatch?: () => void): Promise<CredentialDescriptionReceipt> => {
  const expectedUserId = requestId(input.expectedUserId);
  const expectedDescription = parseCredentialDescription(input.expectedDescription);
  const description = normalizeCredentialDescription(input.description);
  return credentialOperation(signal, async () => {
    const response = await credentialRequest(url, signal, expectedUserId, onIdentityMismatch, {
      method: 'PATCH', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedUserId, expectedDescription, description }),
    }, onDispatch);
    return credentialJson(response, signal, value => {
      if (response.status !== 200) return malformed();
      const data = record(value);
      if (Object.keys(data).some(key => key !== 'id' && key !== 'description') || id(data.id) !== targetId) return malformed();
      const saved = parseCredentialDescription(data.description);
      if (saved !== description) return malformed();
      return { id: targetId, description: saved };
    });
  });
};
