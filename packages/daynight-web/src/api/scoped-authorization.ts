import { normalizeDeviceUserCode, parseDeviceAuthorization } from './auth-parse';
import type { DeviceAuthorizationInspection } from './auth-types';
import { ApiError, assertResponsePrincipal, json, request, requestId, responseSignal } from './client';
import { credentialOperation } from './credential-management';
import { parseCatalogRevision, scopedDecisionFields, type ScopeSelection } from './credential-scope';
import { parseConsent, parseConsentRedirect, type ConsentView } from './oauth-consent';
import { malformed, record } from './parse';

export type ScopedDeviceInspection = DeviceAuthorizationInspection & { readonly catalogRevision?: string };
export type ScopedConsentView = ConsentView & { readonly catalogRevision?: string };

const revisionForStatus = (data: Record<string, unknown>, status: string): { catalogRevision?: string } => {
  if (status === 'pending') return { catalogRevision: parseCatalogRevision(data.catalogRevision) };
  if (data.catalogRevision !== undefined) return malformed();
  return {};
};
const deviceCode = (code: string): string => {
  if (normalizeDeviceUserCode(code) !== code) throw new ApiError('protocol');
  return code;
};
const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };

export const inspectScopedDeviceAuthorization = (code: string, userId: string, signal: AbortSignal, onIdentityMismatch: () => void): Promise<ScopedDeviceInspection> => credentialOperation(signal, async () => {
  const userCode = deviceCode(code), expected = requestId(userId);
  const response = await request('/api/v2/auth/device/inspect', signal, { method: 'POST', headers, body: JSON.stringify({ userCode }) });
  assertResponsePrincipal(response, expected, onIdentityMismatch);
  return json(response, signal, value => {
    if (response.status !== 200) return malformed();
    const parsed = parseDeviceAuthorization(value, userCode);
    return { ...parsed, ...revisionForStatus(record(value), parsed.status) };
  });
});

export const decideScopedDeviceAuthorization = (code: string, decision: 'approve' | 'deny', userId: string, selection: ScopeSelection | undefined, signal: AbortSignal, onIdentityMismatch: () => void, onDispatch?: () => void, onUnauthorized?: () => void): Promise<void> => credentialOperation(signal, async () => {
  const userCode = deviceCode(code), expectedUserId = requestId(userId);
  const body = JSON.stringify({ userCode, decision, expectedUserId, ...scopedDecisionFields(decision, selection) });
  const response = await request('/api/v2/auth/device/decision', signal, { method: 'POST', headers, body }, onDispatch, onUnauthorized);
  assertResponsePrincipal(response, expectedUserId, onIdentityMismatch);
  responseSignal(response, signal).throwIfAborted();
  if (!response.ok) return json(response, signal, () => malformed());
  if (response.status !== 204) throw new ApiError('protocol', response.status);
});

export const inspectScopedConsent = (request: string, userId: string, signal: AbortSignal, onIdentityMismatch: () => void): Promise<ScopedConsentView> => credentialOperation(signal, async () => {
  const target = requestId(request), expected = requestId(userId);
  const response = await requestScopedConsent(target, signal);
  assertResponsePrincipal(response, expected, onIdentityMismatch);
  return json(response, signal, value => {
    if (response.status !== 200) return malformed();
    const data = record(value);
    if (data.userId !== expected) onIdentityMismatch();
    const parsed = parseConsent(value, target, expected);
    return { ...parsed, ...revisionForStatus(data, parsed.status) };
  });
});
const requestScopedConsent = (id: string, signal: AbortSignal) => request(`/api/v2/oauth/requests/${id}`, signal, { headers: { Accept: 'application/json' } });

export const decideScopedConsent = (view: ScopedConsentView, decision: 'approve' | 'deny', selection: ScopeSelection | undefined, signal: AbortSignal, onUnauthorized?: () => void, onDispatch?: () => void, onIdentityMismatch?: () => void): Promise<string> => credentialOperation(signal, async () => {
  const expectedUserId = requestId(view.userId);
  const body = JSON.stringify({ expectedUserId, decision, ...scopedDecisionFields(decision, selection) });
  const response = await request(`/api/v2/oauth/requests/${requestId(view.requestId)}/decision`, signal, { method: 'POST', headers, body }, onDispatch, onUnauthorized);
  assertResponsePrincipal(response, expectedUserId, onIdentityMismatch);
  return json(response, signal, value => {
    if (response.status !== 200) return malformed();
    return parseConsentRedirect(value, view, decision);
  });
});
