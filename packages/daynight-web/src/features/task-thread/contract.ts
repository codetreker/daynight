import { decodeThreadJsonSource, parseThreadMessage as parseMessage, parseThreadPage as parsePage, THREAD_MESSAGE_BYTES, THREAD_PAGE_BYTES } from '../../../../daynight/src/api/thread';
import { canonicalId } from '../../../../daynight/src/api/validation';
import { isNonemptyText, isText } from '../../../../daynight/src/platform/text';
import type { ThreadMessage, ThreadPage } from '../../../../daynight/src/api/types';
import { ApiError } from '../../api/client';

export type { ThreadAuthor, ThreadExecution, ThreadMessage, ThreadPage } from '../../../../daynight/src/api/types';
export { THREAD_MESSAGE_BYTES, THREAD_PAGE_BYTES };

export type ThreadScope = { readonly userId: string; readonly projectId: string; readonly taskId: string };
export type ThreadQuery = { readonly count: number; readonly beforeId?: string; readonly afterId?: string; readonly fromBeginning?: true };
export type PostThreadInput = { readonly body: string; readonly replyTo?: string };
export type ThreadPosition = Pick<ThreadMessage, 'id' | 'createdAt'>;

const encoder = new TextEncoder();
const protocol = (cause?: unknown): never => { throw new ApiError('protocol', null, 'protocol', null, cause); };
export const compareThreadPositions = (left: ThreadPosition, right: ThreadPosition): number =>
  left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

export const encodedMessageBytes = (message: ThreadMessage): number => encoder.encode(JSON.stringify(message)
  .replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)).byteLength;

export const isThreadBody = (body: unknown): body is string => isNonemptyText(body) && encoder.encode(body).byteLength <= THREAD_MESSAGE_BYTES;

export const assertThreadId = (value: string): void => { if (!isText(value) || canonicalId(value) !== value) protocol(); };
export const assertThreadScope = (scope: ThreadScope): void => {
  assertThreadId(scope.userId); assertThreadId(scope.projectId); assertThreadId(scope.taskId);
};
export const assertThreadQuery = (query: ThreadQuery): void => {
  if (!Number.isInteger(query.count) || query.count < 1 || query.count > 100 ||
    query.beforeId !== undefined && query.afterId !== undefined ||
    query.fromBeginning !== undefined && (query.fromBeginning !== true || query.beforeId !== undefined || query.afterId !== undefined)) protocol();
  if (query.beforeId !== undefined) assertThreadId(query.beforeId);
  if (query.afterId !== undefined) assertThreadId(query.afterId);
};
export const assertPostThreadInput = (input: PostThreadInput): void => {
  if (Object.keys(input).some((key) => key !== 'body' && key !== 'replyTo') || !isThreadBody(input.body)) {
    throw new ApiError('protocol', null, 'invalid_input');
  }
  if (input.replyTo !== undefined) assertThreadId(input.replyTo);
};

const parse = <T>(source: string, kind: 'page' | 'message', convert: (value: unknown) => T): T => {
  try { return convert(decodeThreadJsonSource(source, kind)); }
  catch (error) { return protocol(error); }
};
export const parseThreadMessage = (source: string): ThreadMessage => parse(source, 'message', (value) => {
  const message = parseMessage(value, false);
  if (encodedMessageBytes(message) > THREAD_MESSAGE_BYTES) return protocol();
  return message;
});
export const parseThreadPage = (source: string, query: ThreadQuery, boundary?: ThreadPosition): ThreadPage => parse(source, 'page', (value) => {
  if (boundary !== undefined && boundary.id !== query.beforeId && boundary.id !== query.afterId) return protocol();
  const page = parsePage(value, { ...query, details: true });
  for (const message of page.items) {
    if (encodedMessageBytes(message) > THREAD_MESSAGE_BYTES) return protocol();
    if (boundary !== undefined && (query.beforeId !== undefined && compareThreadPositions(message, boundary) >= 0 ||
      query.afterId !== undefined && compareThreadPositions(message, boundary) <= 0)) return protocol();
  }
  return page;
});

export const mergeThreadMessage = (current: ThreadMessage, incoming: ThreadMessage): ThreadMessage => {
  if (current.id !== incoming.id || current.createdAt !== incoming.createdAt || current.body !== incoming.body || current.replyTo !== incoming.replyTo ||
    current.author.userId !== incoming.author.userId || current.author.displayName !== incoming.author.displayName || current.author.Agent !== incoming.author.Agent) return protocol();
  const previous = current.author.execution, next = incoming.author.execution;
  if (previous !== undefined && next !== undefined && (previous.claimId !== next.claimId || previous.workerId !== next.workerId || previous.provider !== next.provider)) return protocol();
  return previous === undefined && next !== undefined ? incoming : current;
};
