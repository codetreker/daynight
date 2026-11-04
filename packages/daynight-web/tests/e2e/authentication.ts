import type { APIRequestContext, APIResponse, BrowserContext, Route } from '@playwright/test';
import { login } from '../../scripts/acceptance/auth-fixture.mts';

type RequestMethod = 'delete' | 'fetch' | 'get' | 'head' | 'patch' | 'post' | 'put';
export type AuthenticatedAPI = Pick<APIRequestContext, RequestMethod | 'dispose'>;
type FailureCategory = 'timeout' | 'aborted' | 'transport' | 'response';

const safePath = (input: string): string => {
  try { return new URL(input, 'http://acceptance.invalid').pathname; }
  catch { return '[invalid-path]'; }
};
const failed = (operation: string, method: string, path: string, error: unknown, response?: APIResponse): Error => {
  const category: FailureCategory = error instanceof Error && /timeout|timed out/i.test(error.message) ? 'timeout'
    : error instanceof Error && error.name === 'AbortError' ? 'aborted' : response === undefined ? 'transport' : 'response';
  const status = response?.status();
  const identifier = response?.headers()['x-request-id'];
  const requestId = identifier !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier) ? identifier : undefined;
  // Playwright call logs include credential headers; no original error or cause crosses this boundary.
  return Object.assign(new Error(`Authenticated acceptance ${operation} failed: ${method} ${path} (${category}).`),
    { operation, method, path, category, ...(status === undefined ? {} : { status }), ...(requestId === undefined ? {} : { requestId }) });
};

const safeResponse = (response: APIResponse, method: string, path: string): APIResponse => {
  const read = async <T>(operation: string, action: () => Promise<T>): Promise<T> => {
    try { return await action(); }
    catch (error) { throw failed(operation, method, path, error, response); }
  };
  return {
    body: async () => await read('response body', () => response.body()),
    json: async () => await read('response JSON', () => response.json()),
    text: async () => await read('response text', () => response.text()),
    dispose: async () => await read('response disposal', () => response.dispose()),
    [Symbol.asyncDispose]: async () => await read('response disposal', () => response.dispose()),
    securityDetails: async () => await read('response security details', () => response.securityDetails()),
    serverAddr: async () => await read('response server address', () => response.serverAddr()),
    headers: () => response.headers(), headersArray: () => response.headersArray(),
    ok: () => response.ok(), status: () => response.status(), statusText: () => response.statusText(),
    timing: () => response.timing(), url: () => response.url(),
  };
};

// Our credential-safe wrapper has no native Playwright response identity.
export const fulfillAuthenticatedResponse = async (route: Pick<Route, 'fulfill'>, response: APIResponse): Promise<void> => {
  await route.fulfill({ status: response.status(), headers: response.headers(), body: await response.body() });
};

export const authenticatedAPI = (context: APIRequestContext): AuthenticatedAPI => {
  const invoke = async (method: string, input: Parameters<APIRequestContext['fetch']>[0], action: () => Promise<APIResponse>): Promise<APIResponse> => {
    const path = safePath(typeof input === 'string' ? input : input.url());
    try { return safeResponse(await action(), method, path); }
    catch (error) { throw failed('request', method, path, error); }
  };
  return {
    delete: async (input, options) => await invoke('DELETE', input, () => context.delete(input, options)),
    fetch: async (input, options) => await invoke(options?.method ?? (typeof input === 'string' ? 'GET' : input.method()), input, () => context.fetch(input, options)),
    get: async (input, options) => await invoke('GET', input, () => context.get(input, options)),
    head: async (input, options) => await invoke('HEAD', input, () => context.head(input, options)),
    patch: async (input, options) => await invoke('PATCH', input, () => context.patch(input, options)),
    post: async (input, options) => await invoke('POST', input, () => context.post(input, options)),
    put: async (input, options) => await invoke('PUT', input, () => context.put(input, options)),
    dispose: async (options) => {
      try { await context.dispose(options); }
      catch (error) { throw failed('context disposal', 'DISPOSE', '/', error); }
    },
  };
};

export const browserFetch = (context: APIRequestContext): typeof globalThis.fetch => {
  const request = authenticatedAPI(context);
  return async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init.method ?? 'GET';
    try {
      if (init.body !== undefined && typeof init.body !== 'string') throw new Error('Browser authentication accepts only protocol string bodies.');
      init.signal?.throwIfAborted();
      const response = await request.fetch(url, {
        method, headers: Object.fromEntries(new Headers(init.headers)),
        ...(init.body === undefined ? {} : { data: init.body }), maxRedirects: 0, failOnStatusCode: false, timeout: 10_000,
      });
      init.signal?.throwIfAborted();
      const headers = new Headers();
      for (const header of response.headersArray()) headers.append(header.name, header.value);
      const body = [204, 205, 304].includes(response.status()) ? null : Uint8Array.from(await response.body()).buffer;
      return new Response(body, { status: response.status(), headers });
    } catch (error) { throw failed('browser authentication transport', method, safePath(url), error); }
  };
};

export const browserAuthentication = async (context: BrowserContext, origin: string, persona = 'alice'): Promise<void> => {
  await login({ origin, persona, fetch: browserFetch(context.request) });
};

type RequestFactory = { newContext: (options: { baseURL: string; extraHTTPHeaders: Record<string, string> }) => Promise<APIRequestContext> };
export const tokenContext = async (request: RequestFactory, origin: string, token: string): Promise<AuthenticatedAPI> => {
  try { return authenticatedAPI(await request.newContext({ baseURL: origin, extraHTTPHeaders: { Authorization: `Bearer ${token}` } })); }
  catch (error) { throw failed('API context setup', 'AUTHENTICATE', '/', error); }
};

export const createApiToken = async (origin: string, persona = 'alice'): Promise<string> => {
  try {
    const session = await login({ origin, persona });
    return await session.createPAT('Browser acceptance');
  } catch (error) { throw failed('API authentication setup', 'AUTHENTICATE', '/', error); }
};

export const bearerContext = async (request: RequestFactory,
  origin: string, persona = 'alice'): Promise<AuthenticatedAPI> => {
  try { return await tokenContext(request, origin, await createApiToken(origin, persona)); }
  catch (error) { throw failed('API authentication setup', 'AUTHENTICATE', '/', error); }
};
