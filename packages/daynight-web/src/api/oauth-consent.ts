import { ApiError, isAbortError, request, requestId } from './client';
import { boolean, id, malformed, nonemptyString, record, string } from './parse';

export type ConsentView = { readonly requestId: string; readonly userId: string; readonly status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired'; readonly clientName: string; readonly clientId: string; readonly clientProvenance: 'dcr' | 'cimd' | 'preregistered'; readonly redirectUri: string; readonly resource: string; readonly scope: string; readonly codeExpired: boolean };

const parseURL = (value: string): URL => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return malformed();
    return url;
  } catch { return malformed(); }
};

export const parseConsent = (value: unknown, expectedRequest: string, expectedUser: string): ConsentView => {
  const data = record(value);
  const request = id(data.requestId), user = id(data.userId), status = string(data.status);
  if (request !== expectedRequest || user !== expectedUser || !['pending', 'approved', 'denied', 'consumed', 'expired'].includes(status)) return malformed();
  const provenance = string(data.clientProvenance);
  if (provenance !== 'dcr' && provenance !== 'cimd' && provenance !== 'preregistered') return malformed();
  const redirectUri = nonemptyString(data.redirectUri), resource = nonemptyString(data.resource), clientId = nonemptyString(data.clientId);
  parseURL(redirectUri); parseURL(resource);
  if (provenance === 'cimd' && parseURL(clientId).protocol !== 'https:') return malformed();
  return { requestId: request, userId: user, status: status as ConsentView['status'], clientName: string(data.clientName) || clientId, clientId, clientProvenance: provenance, redirectUri, resource, scope: nonemptyString(data.scope), codeExpired: boolean(data.codeExpired) };
};

// URL.hostname canonicalizes IPv4-mapped IPv6 addresses to hexadecimal.
export const isLoopbackCallback = (raw: string): boolean => {
  const host = parseURL(raw).hostname;
  if (host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}\]$/.exec(host);
  return mapped !== null && (Number.parseInt(mapped[1]!, 16) & 0xff00) === 0x7f00;
};

// Only the previously inspected callback can receive the one-time response.
export const parseConsentRedirect = (value: unknown, view: ConsentView, decision: 'approve' | 'deny'): string => {
  const data = record(value), result = nonemptyString(data.redirectUri);
  const target = parseURL(result), base = parseURL(view.redirectUri);
  if (target.origin !== base.origin || target.pathname !== base.pathname) return malformed();
  const allowed = new URLSearchParams(target.search);
  for (const [key, val] of base.searchParams) {
    const found = allowed.getAll(key);
    const index = found.indexOf(val);
    if (index < 0) return malformed();
    found.splice(index, 1); allowed.delete(key); for (const item of found) allowed.append(key, item);
  }
  for (const key of allowed.keys()) if (!['code', 'state', 'iss', 'error'].includes(key) || allowed.getAll(key).length !== 1) return malformed();
  if (allowed.get('iss') !== new URL(view.resource).origin || (decision === 'approve' ? !allowed.get('code') || allowed.has('error') : allowed.get('error') !== 'access_denied' || allowed.has('code'))) return malformed();
  return result;
};

const responseJSON = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  try {
    if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('Content-Type') ?? '')) throw new Error('Invalid media type');
    const data: unknown = await response.json(); signal.throwIfAborted();
    if (!response.ok) {
      const body = record(data); throw new ApiError('server', response.status, typeof body.error === 'string' ? body.error : 'server');
    }
    if (response.status !== 200) throw new ApiError('protocol', response.status);
    return data;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ApiError || isAbortError(error)) throw error;
    throw new ApiError('protocol', response.status);
  }
};

export const inspectConsent = async (request: string, user: string, signal: AbortSignal, onIdentityMismatch: () => void): Promise<ConsentView> => {
  requestId(request); requestId(user);
  const response = await requestConsent(request, signal);
  const data = await responseJSON(response, signal);
  try { return parseConsent(data, request, user); }
  catch { if (typeof data === 'object' && data !== null && 'userId' in data && data.userId !== user) onIdentityMismatch(); throw new ApiError('protocol', response.status); }
};
const requestConsent = (id: string, signal: AbortSignal) => request(`/api/v1/oauth/requests/${id}`, signal, { headers: { Accept: 'application/json' } });

export const decideConsent = async (view: ConsentView, decision: 'approve' | 'deny', signal: AbortSignal, onUnauthorized?: () => void, onDispatch?: () => void): Promise<string> => {
  const response = await request(`/api/v1/oauth/requests/${requestId(view.requestId)}/decision`, signal, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedUserId: requestId(view.userId), decision }) }, onDispatch, onUnauthorized);
  const data = await responseJSON(response, signal);
  try { return parseConsentRedirect(data, view, decision); } catch { throw new ApiError('protocol', response.status); }
};
