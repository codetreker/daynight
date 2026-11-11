import { awaitAbortable } from '../../../../daynight/src/api/abort';
import { decodeThreadJsonSource } from '../../../../daynight/src/api/thread';
import { ApiError, responseSignal } from '../../api/client';

export const THREAD_ERROR_BYTES = 16_384;

export const rejectThreadResponse = async (response: Response, signal?: AbortSignal): Promise<never> => {
  const lifetime = signal === undefined ? undefined : responseSignal(response, signal);
  lifetime?.throwIfAborted();
  const error = new ApiError('protocol', response.status);
  try {
    const cleanup = response.body?.cancel(error);
    if (cleanup !== undefined) await (lifetime === undefined ? cleanup : awaitAbortable(cleanup, lifetime));
  }
  catch (cause) { lifetime?.throwIfAborted(); throw new ApiError('protocol', response.status, 'protocol', null, new AggregateError([error, cause], 'The response and its cleanup failed.')); }
  lifetime?.throwIfAborted();
  throw error;
};

export const readThreadJsonSource = async (response: Response, signal: AbortSignal, limit?: number): Promise<string> => {
  signal = responseSignal(response, signal);
  signal.throwIfAborted();
  const type = response.headers.get('Content-Type');
  if (type === null || !/^application\/json(?:\s*;|\s*$)/i.test(type)) return rejectThreadResponse(response, signal);
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || limit !== undefined && Number(length) > limit)) return rejectThreadResponse(response, signal);
  if (response.body === null) throw new ApiError('protocol', response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  let cancellation: Promise<void> | undefined;
  const cancelOnce = (reason?: unknown): Promise<void> => cancellation ??= reader.cancel(reason);
  const cancel = (): void => {
    // The request's abort remains the outcome even if transport cleanup also fails.
    void cancelOnce(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (limit !== undefined && bytes > limit) throw new ApiError('protocol', response.status);
      chunks.push(decoder.decode(item.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    signal.throwIfAborted();
    let cause = error;
    try { await awaitAbortable(cancelOnce(error), signal); }
    catch (cleanupError) { cause = new AggregateError([error, cleanupError], 'The response and its cleanup failed.'); }
    signal.throwIfAborted();
    if (cause instanceof ApiError) throw cause;
    throw new ApiError('protocol', response.status, 'protocol', null, cause);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
};

export const decodeThreadError = (source: string): unknown => decodeThreadJsonSource(source);
