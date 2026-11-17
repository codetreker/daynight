import { ApiError, readAuthRequestGeneration, waitForAuthRequests } from '../../api/client';
import { getGitHubStatus, getPullRequests } from './api';

export type ReadToken = { readonly epoch: number; readonly auth: number };
type Listener = (error?: ApiError) => void;
type Options = {
  readonly userId: string; readonly projectId: string;
  readonly isAllowed: () => boolean;
  readonly onPrincipalMismatch: () => void;
  readonly onAccessError: (error: ApiError) => void;
};

/** A shared authorization boundary for the list and author directory. */
export const createReadSession = (options: Options) => {
  let epoch = 0;
  let directoryAuthorized = true;
  let baselineGeneration = 0;
  let revoked = false;
  const listeners = new Set<Listener>();
  const capture = (): ReadToken => ({ epoch, auth: readAuthRequestGeneration() });
  const isAllowed = () => !revoked && options.isAllowed();
  const current = (token: ReadToken): boolean => token.epoch === epoch && token.auth === readAuthRequestGeneration() && isAllowed();
  const revoke = (error?: ApiError) => {
    epoch += 1;
    baselineGeneration += 1;
    revoked = true;
    directoryAuthorized = false;
    for (const listener of listeners) listener(error);
    if (error?.code === 'principal_mismatch') options.onPrincipalMismatch();
    else if (error?.kind === 'server' && (error.status === 403 || error.status === 404)) options.onAccessError(error);
  };
  const resume = () => { if (revoked) { epoch += 1; revoked = false; directoryAuthorized = true; } };
  const accept = async (token: ReadToken, signal: AbortSignal): Promise<boolean> => {
    try { await waitForAuthRequests(signal); }
    catch (error) {
      if (!signal.aborted && token.epoch === epoch && token.auth !== readAuthRequestGeneration()) revoke();
      throw error;
    }
    if (token.epoch === epoch && token.auth !== readAuthRequestGeneration()) revoke();
    return current(token);
  };
  const request = async <T,>(signal: AbortSignal, read: (signal: AbortSignal, onDispatch: () => void) => Promise<T>): Promise<T> => {
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    const combined = AbortSignal.any([signal, deadline.signal]);
    let removeAbort = () => {};
    try {
      const aborted = new Promise<never>((_, reject) => {
        const abort = () => reject(new DOMException('Request cancelled', 'AbortError'));
        if (combined.aborted) abort();
        else { combined.addEventListener('abort', abort, { once: true }); removeAbort = () => combined.removeEventListener('abort', abort); }
      });
      return await Promise.race([read(combined, () => {
        timer = setTimeout(() => { timedOut = true; deadline.abort(); }, 30_000);
      }), aborted]);
    } catch (error) {
      if (timedOut) throw new ApiError('network');
      throw error;
    } finally { removeAbort(); if (timer !== undefined) clearTimeout(timer); }
  };
  const subscribe = (listener: Listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const verifyBaseline = async (signal: AbortSignal): Promise<boolean> => {
    const generation = ++baselineGeneration;
    directoryAuthorized = false;
    const token = capture();
    const admission = (onDispatch: () => void) => ({ userId: options.userId, onPrincipalMismatch: () => {}, onDispatch });
    const check = async <T,>(read: (signal: AbortSignal, dispatch: () => void) => Promise<T>) => {
      try { await request(signal, read); return await accept(token, signal); }
      catch (cause) {
        if (cause instanceof ApiError && (cause.code === 'principal_mismatch' || cause.status === 401 || cause.kind === 'server' && (cause.status === 403 || cause.status === 404))) {
          try { if (await accept(token, signal)) revoke(cause); } catch { /* Cancelled or inconclusive authentication cannot establish a denial. */ }
        }
        return false;
      }
    };
    const results = await Promise.all([
      check((s, dispatch) => getGitHubStatus(options.projectId, s, admission(dispatch))),
      check((s, dispatch) => getPullRequests(options.projectId, { state: 'all', q: '', cursor: null }, s, admission(dispatch))),
    ]);
    const verified = results.every(Boolean) && current(token) && generation === baselineGeneration;
    if (verified) directoryAuthorized = true;
    return verified;
  };
  const recover = async (signal: AbortSignal): Promise<boolean> => {
    if (!revoked || !options.isAllowed()) return false;
    const token = capture(), generation = ++baselineGeneration;
    const admission = (onDispatch: () => void) => ({ userId: options.userId, onPrincipalMismatch: () => {}, onDispatch });
    const reads = await Promise.allSettled([
      request(signal, (s, dispatch) => getGitHubStatus(options.projectId, s, admission(dispatch))),
      request(signal, (s, dispatch) => getPullRequests(options.projectId, { state: 'all', q: '', cursor: null }, s, admission(dispatch))),
    ]);
    if (reads.some(result => result.status === 'rejected') || signal.aborted) return false;
    try { await waitForAuthRequests(signal); } catch { return false; }
    if (!revoked || generation !== baselineGeneration || token.epoch !== epoch || token.auth !== readAuthRequestGeneration() || !options.isAllowed()) return false;
    resume();
    return true;
  };
  return { capture, current, accept, request, subscribe, revoke, resume, recover, verifyBaseline, isAllowed, isRevoked: () => revoked, isDirectoryAllowed: () => directoryAuthorized };
};
export type ReadSession = ReturnType<typeof createReadSession>;
