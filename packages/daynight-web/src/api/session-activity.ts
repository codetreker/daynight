import { ApiError, assertResponsePrincipal, json, request, requestId, responseSignal } from './client';

export const reportBrowserSessionActivity = async (userId: string, signal: AbortSignal, onIdentityMismatch: () => void): Promise<void> => {
  const expectedUserId = requestId(userId);
  const response = await request('/api/v1/auth/session/activity', signal, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedUserId }),
  });
  if (!response.ok) return json(response, signal, () => { throw new ApiError('protocol', response.status); }, undefined, false, error => {
    if (error.code === 'identity_mismatch') onIdentityMismatch();
  });
  assertResponsePrincipal(response, expectedUserId, onIdentityMismatch);
  responseSignal(response, signal).throwIfAborted();
  if (response.status !== 204) throw new ApiError('protocol', response.status);
};
