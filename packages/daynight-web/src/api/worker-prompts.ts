import { decodeStrictSessionJson } from '../../../daynight/src/session/v2/values';
import { ApiError, assertResponsePrincipal, json, request, requestId } from './client';
import { id, malformed, record, string, timestamp } from './parse';
import { parseConfigurationRevision } from './worker-configuration';

export type PromptTarget =
  | { readonly scope: 'user' }
  | { readonly scope: 'project'; readonly projectId: string }
  | { readonly scope: 'worker'; readonly workerId: string };
export type PromptResource = {
  readonly scope: PromptTarget['scope']; readonly scopeId: string; readonly revision: string;
  readonly text: string; readonly updatedAt: string | null;
};
export type PromptSubmission = { readonly expectedUserId: string; readonly revision: string; readonly text: string };
export type PromptAdmission = { readonly userId: string; readonly onPrincipalMismatch: () => void; readonly onDispatch?: () => void; readonly onReceipt?: (resource: PromptResource) => void; readonly onRejection?: (error: ApiError) => void };

export const PROMPT_REQUEST_BYTES = 1024 * 1024;
export const PROMPT_RESPONSE_BYTES = 6 * 1024 * 1024 + 4096;

export const isPromptText = (value: unknown): value is string =>
  typeof value === 'string' && value.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(value);

export const promptSubmissionBytes = (submission: PromptSubmission): number =>
  new TextEncoder().encode(JSON.stringify(submission)).byteLength;

const targetPath = (target: PromptTarget, userId: string): { url: string; scopeId: string } => {
  switch (target.scope) {
    case 'user': return { url: '/api/v1/me/worker-prompt', scopeId: userId };
    case 'project': { const scopeId = requestId(target.projectId); return { url: `/api/v1/me/projects/${scopeId}/worker-prompt`, scopeId }; }
    case 'worker': { const scopeId = requestId(target.workerId); return { url: `/api/v1/me/workers/${scopeId}/prompt`, scopeId }; }
    default: throw new ApiError('protocol');
  }
};

export const parsePromptResource = (value: unknown, target: PromptTarget, userId: string): PromptResource => {
  const data = record(value), keys = ['scope', 'scopeId', 'revision', 'text', 'updatedAt'];
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) return malformed();
  const expectedId = targetPath(target, requestId(userId)).scopeId;
  const scopeId = id(data.scopeId), revision = parseConfigurationRevision(data.revision, true), text = string(data.text);
  if (data.scope !== target.scope || scopeId !== expectedId || !isPromptText(text) || new TextEncoder().encode(text).byteLength > PROMPT_REQUEST_BYTES) return malformed();
  const updatedAt = data.updatedAt === null ? null : timestamp(data.updatedAt);
  if (revision === '0' ? text !== '' || updatedAt !== null : updatedAt === null) return malformed();
  return { scope: target.scope, scopeId, revision, text, updatedAt };
};

// A server may escape each character as six ASCII bytes. Bound the raw stream,
// including chunked responses, before decoding and parsing any resource.
const decodePromptJson = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  if (response.body === null) throw new Error('Missing response body');
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(PROMPT_RESPONSE_BYTES))) {
    await response.body.cancel();
    throw new Error('Prompt response exceeds its budget');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > PROMPT_RESPONSE_BYTES) throw new Error('Prompt response exceeds its budget');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return decodeStrictSessionJson(bytes, PROMPT_RESPONSE_BYTES);
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

export const getWorkerPrompt = async (target: PromptTarget, signal: AbortSignal, admission: PromptAdmission): Promise<PromptResource> => {
  const userId = requestId(admission.userId), { url } = targetPath(target, userId);
  const response = await request(url, signal, { headers: { Accept: 'application/json' } });
  assertResponsePrincipal(response, userId, admission.onPrincipalMismatch);
  return json(response, signal, value => {
    if (response.status !== 200) throw new ApiError('protocol', response.status);
    return parsePromptResource(value, target, userId);
  }, response => decodePromptJson(response, signal));
};

export const saveWorkerPrompt = async (target: PromptTarget, submission: PromptSubmission, signal: AbortSignal, admission: PromptAdmission): Promise<PromptResource> => {
  const userId = requestId(admission.userId), expectedUserId = requestId(submission.expectedUserId);
  if (expectedUserId !== userId || !isPromptText(submission.text)) throw new ApiError('protocol');
  const revision = parseConfigurationRevision(submission.revision, true);
  const input = { expectedUserId, revision, text: submission.text };
  if (promptSubmissionBytes(input) > PROMPT_REQUEST_BYTES) throw new ApiError('protocol', null, 'payload_too_large');
  const { url } = targetPath(target, userId);
  const response = await request(url, signal, {
    method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }, admission.onDispatch);
  assertResponsePrincipal(response, userId, admission.onPrincipalMismatch);
  let resource: PromptResource;
  try {
    resource = await json(response, signal, value => {
      if (response.status !== 200) throw new ApiError('protocol', response.status);
      const resource = parsePromptResource(value, target, userId);
      if (resource.text !== input.text || BigInt(resource.revision) < BigInt(revision) || BigInt(resource.revision) > BigInt(revision) + 1n) throw new ApiError('protocol', response.status);
      return resource;
    }, response => decodePromptJson(response, signal));
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'server' && error.status !== null && error.status >= 400 && error.status < 500) admission.onRejection?.(error);
    throw error;
  }
  admission.onReceipt?.(resource);
  return resource;
};
