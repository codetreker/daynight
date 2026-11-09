import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CDPSession, Page, TestInfo } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withCapacityTrace } from './helpers/capacity-trace';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const fixture = async () => {
  await mkdir('.tmp', { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), '.tmp/capacity-trace-'));
  directories.push(directory);
  const emitter = new EventEmitter();
  const detach = vi.fn().mockResolvedValue(undefined);
  let reads = 0;
  const send = vi.fn().mockImplementation(async (method: string) => {
    if (method === 'Tracing.end') queueMicrotask(() => emitter.emit('Tracing.tracingComplete', { stream: 'stream-1' }));
    if (method === 'IO.read') {
      reads++;
      return reads === 1 ? { data: '{"traceEvents":', eof: false } : { data: Buffer.from('[]}').toString('base64'), base64Encoded: true, eof: true };
    }
    return {};
  });
  const session = Object.assign(emitter, { send, detach }) as unknown as CDPSession;
  const page = { context: () => ({ newCDPSession: async () => session }) } as unknown as Page;
  const attach = vi.fn().mockResolvedValue(undefined);
  const info = { outputPath: (name: string) => join(directory, name), attach } as unknown as TestInfo;
  return { directory, emitter, send, detach, page, info, attach };
};

describe('Chromium capacity diagnostics', () => {
  it('streams trace chunks and attaches CPU timeline evidence after a successful interaction', async () => {
    const context = await fixture();
    await expect(withCapacityTrace(context.page, context.info, 'capacity-shared-repetition-0', async () => 42)).resolves.toBe(42);
    expect(context.send).toHaveBeenNthCalledWith(1, 'Tracing.start', expect.objectContaining({
      transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'none',
      categories: expect.stringContaining('disabled-by-default-v8.gc'),
    }));
    expect(context.send.mock.calls[0]?.[1].categories).toContain('blink.user_timing');
    expect(context.send.mock.calls[0]?.[1].categories).not.toContain('v8.cpu_profiler');
    expect(context.send).toHaveBeenCalledWith('IO.close', { handle: 'stream-1' });
    expect(context.detach).toHaveBeenCalledOnce();
    const path = join(context.directory, 'capacity-shared-repetition-0-chromium-trace.json');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ traceEvents: [] });
    expect(context.attach).toHaveBeenCalledWith('capacity-shared-repetition-0-chromium-trace', { path, contentType: 'application/json' });
  });

  it('retains the trace and original cause when an interaction fails its actual budget', async () => {
    const context = await fixture();
    const failure = new Error('Zoom exceeded 300 ms');
    await expect(withCapacityTrace(context.page, context.info, 'failed-zoom', async () => { throw failure; })).rejects.toBe(failure);
    expect(context.attach).toHaveBeenCalledOnce();
    expect(context.detach).toHaveBeenCalledOnce();
  });

  it('preserves both interaction and trace errors and closes the stream and CDP session', async () => {
    const context = await fixture();
    const interaction = new Error('Interaction failed');
    const trace = new Error('Trace stream failed');
    context.send.mockImplementation(async (method: string) => {
      if (method === 'Tracing.end') queueMicrotask(() => context.emitter.emit('Tracing.tracingComplete', { stream: 'stream-1' }));
      if (method === 'IO.read') throw trace;
      return {};
    });
    const error: unknown = await withCapacityTrace(context.page, context.info, 'stream-failure', async () => { throw interaction; }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([interaction, trace]);
    expect(context.send).toHaveBeenCalledWith('IO.close', { handle: 'stream-1' });
    expect(context.detach).toHaveBeenCalledOnce();
  });

  it('surfaces trace initialization and attachment failures without swallowing them', async () => {
    const context = await fixture();
    const initialization = new Error('Tracing unsupported');
    context.send.mockRejectedValueOnce(initialization);
    const operation = vi.fn();
    await expect(withCapacityTrace(context.page, context.info, 'init-failure', operation)).rejects.toBe(initialization);
    expect(operation).not.toHaveBeenCalled();
    expect(context.detach).toHaveBeenCalledOnce();
    const attachmentContext = await fixture();
    const attachment = new Error('Attachment failed');
    attachmentContext.attach.mockRejectedValueOnce(attachment);
    await expect(withCapacityTrace(attachmentContext.page, attachmentContext.info, 'attachment-failure', async () => undefined)).rejects.toBe(attachment);
    expect(attachmentContext.detach).toHaveBeenCalledOnce();
  });

  it('rejects missing trace streams and preserves session cleanup failures', async () => {
    const context = await fixture();
    context.send.mockImplementation(async (method: string) => {
      if (method === 'Tracing.end') queueMicrotask(() => context.emitter.emit('Tracing.tracingComplete', {}));
      return {};
    });
    const detach = new Error('Session closure failed');
    context.detach.mockRejectedValueOnce(detach);
    const error: unknown = await withCapacityTrace(context.page, context.info, 'missing-stream', async () => undefined).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toMatchObject({ message: 'Chromium tracing did not return an evidence stream.' });
    expect((error as AggregateError).errors[1]).toBe(detach);
  });
});
