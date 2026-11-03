import { ApiError, assertResponsePrincipal, request } from '../../api/client';
import { parseServerError } from '../../api/parse';
import { assertPostThreadInput, assertThreadQuery, assertThreadScope, parseThreadMessage, parseThreadPage, THREAD_MESSAGE_BYTES, THREAD_PAGE_BYTES, type PostThreadInput, type ThreadMessage, type ThreadPage, type ThreadPosition, type ThreadQuery, type ThreadScope } from './contract';
import { decodeThreadError, readThreadJsonSource, rejectThreadResponse, THREAD_ERROR_BYTES } from './json';

export const THREAD_REQUEST_TIMEOUT_MS = 15_000;
export type ThreadAdmission = {
  readonly assertCurrent: () => void;
  readonly onPrincipalMismatch: () => void;
  readonly boundary?: ThreadPosition;
  readonly onDispatch?: () => void;
  readonly onConfirmed?: (message: ThreadMessage) => void;
};
export type ThreadPostOutcome = 'not_sent' | 'refused' | 'unknown';
export class ThreadPostError extends Error {
  constructor(readonly outcome: ThreadPostOutcome, cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Unable to send the discussion message.', { cause });
    this.name = 'ThreadPostError';
  }
}

const serverError = async (response: Response, signal: AbortSignal, admission: ThreadAdmission): Promise<never> => {
  const source = await readThreadJsonSource(response, signal, THREAD_ERROR_BYTES);
  let error: ReturnType<typeof parseServerError>;
  try {
    error = parseServerError(decodeThreadError(source));
  } catch (cause) {
    throw new ApiError('protocol', response.status, 'protocol', null, undefined, cause);
  }
  admission.assertCurrent();
  throw new ApiError('server', response.status, error.code, error.requestId, error.graphLimit);
};
const resource = (scope: ThreadScope): string => {
  assertThreadScope(scope);
  return `/api/v1/projects/${scope.projectId}/tasks/${scope.taskId}/thread/messages`;
};
const assertPrincipal = (response: Response, scope: ThreadScope, admission: ThreadAdmission): void => {
  admission.assertCurrent();
  assertResponsePrincipal(response, scope.userId, () => { admission.assertCurrent(); admission.onPrincipalMismatch(); });
};
const requestTimer = (signal: AbortSignal, admission: ThreadAdmission) => {
  const timeout = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  return {
    signal: AbortSignal.any([signal, timeout.signal]),
    dispatch: () => {
      admission.assertCurrent();
      admission.onDispatch?.();
      timer = setTimeout(() => timeout.abort(new DOMException('The discussion request timed out.', 'TimeoutError')), THREAD_REQUEST_TIMEOUT_MS);
    },
    clear,
  };
};

export const getThreadPage = async (scope: ThreadScope, query: ThreadQuery, signal: AbortSignal, admission: ThreadAdmission): Promise<ThreadPage> => {
  assertThreadQuery(query);
  const parameters = new URLSearchParams({ count: String(query.count), details: 'true' });
  if (query.beforeId !== undefined) parameters.set('beforeId', query.beforeId);
  if (query.afterId !== undefined) parameters.set('afterId', query.afterId);
  if (query.fromBeginning === true) parameters.set('fromBeginning', 'true');
  const url = `${resource(scope)}?${parameters}`;
  const timer = requestTimer(signal, admission);
  try {
    const response = await request(url, timer.signal, { headers: { Accept: 'application/json' } }, timer.dispatch);
    assertPrincipal(response, scope, admission);
    if (!response.ok) return await serverError(response, timer.signal, admission);
    if (response.status !== 200) return await rejectThreadResponse(response);
    const source = await readThreadJsonSource(response, timer.signal, THREAD_PAGE_BYTES);
    const page = parseThreadPage(source, query, admission.boundary);
    admission.assertCurrent();
    return page;
  } catch (error) {
    admission.assertCurrent();
    throw error;
  } finally { timer.clear(); }
};

const refusal = (error: unknown): boolean => error instanceof ApiError && error.kind === 'server' &&
  (error.status !== null && error.status >= 400 && error.status < 500 || error.status === 503 && error.code === 'clock_not_advanced');

export const postThreadMessage = async (scope: ThreadScope, input: PostThreadInput, signal: AbortSignal, admission: ThreadAdmission): Promise<ThreadMessage> => {
  let dispatched = false;
  let confirmed = false;
  const timer = requestTimer(signal, { ...admission, onDispatch: () => { admission.onDispatch?.(); dispatched = true; } });
  try {
    assertPostThreadInput(input);
    const response = await request(resource(scope), timer.signal, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }, timer.dispatch);
    assertPrincipal(response, scope, admission);
    if (!response.ok) return await serverError(response, timer.signal, admission);
    if (response.status !== 201) return await rejectThreadResponse(response);
    const source = await readThreadJsonSource(response, timer.signal, THREAD_MESSAGE_BYTES);
    const message = parseThreadMessage(source);
    if (message.author.userId !== scope.userId || message.author.Agent || message.body !== input.body || message.replyTo !== input.replyTo) throw new ApiError('protocol', response.status);
    timer.clear();
    confirmed = true;
    admission.onConfirmed?.(message);
    return message;
  } catch (error) {
    if (confirmed) throw error;
    throw new ThreadPostError(!dispatched ? 'not_sent' : refusal(error) ? 'refused' : 'unknown', error);
  } finally { timer.clear(); }
};

export const isThreadScopeLoss = (error: unknown): boolean => {
  const cause = error instanceof ThreadPostError ? error.cause : error;
  return cause instanceof ApiError && cause.kind === 'server' && (
    cause.status === 403 && cause.code === 'forbidden' || cause.status === 404 && cause.code === 'not_found' || cause.status === 410 && cause.code === 'task_deleted'
  );
};
