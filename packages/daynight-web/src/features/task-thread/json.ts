import { decodeThreadJsonSource } from '../../../../daynight/src/api/thread';
import { ApiError } from '../../api/client';

export const THREAD_ERROR_BYTES = 16_384;

export const rejectThreadResponse = async (response: Response): Promise<never> => {
  const error = new ApiError('protocol', response.status);
  try { await response.body?.cancel(error); }
  catch (cause) { throw new ApiError('protocol', response.status, 'protocol', null, new AggregateError([error, cause], 'The response and its cleanup failed.')); }
  throw error;
};

export const readThreadJsonSource = async (response: Response, signal: AbortSignal, limit?: number): Promise<string> => {
  const type = response.headers.get('Content-Type');
  if (type === null || !/^application\/json(?:\s*;|\s*$)/i.test(type)) return rejectThreadResponse(response);
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || limit !== undefined && Number(length) > limit)) return rejectThreadResponse(response);
  if (response.body === null) throw new ApiError('protocol', response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  const cancel = (): void => {
    // The request's abort remains the outcome even if transport cleanup also fails.
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (limit !== undefined && bytes > limit) {
        await reader.cancel();
        throw new ApiError('protocol', response.status);
      }
      chunks.push(decoder.decode(item.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    signal.throwIfAborted();
    let cause = error;
    try { await reader.cancel(error); }
    catch (cleanupError) { cause = new AggregateError([error, cleanupError], 'The response and its cleanup failed.'); }
    if (cause instanceof ApiError) throw cause;
    throw new ApiError('protocol', response.status, 'protocol', null, cause);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
};

export const decodeThreadError = (source: string): unknown => decodeThreadJsonSource(source);
