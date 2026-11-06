import { open } from 'node:fs/promises';
import type { CDPSession, Page, TestInfo } from '@playwright/test';

const categories = [
  'devtools.timeline', 'blink.user_timing', 'toplevel', 'v8.execute', 'v8', 'disabled-by-default-v8.gc', 'cc',
  'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
].join(',');

const complete = (session: CDPSession): { readonly result: Promise<string>; readonly cancel: () => void } => {
  let timer: ReturnType<typeof setTimeout>;
  let resolve!: (stream: string) => void;
  let reject!: (error: Error) => void;
  const finished = (event: { stream?: string }) => {
    clearTimeout(timer);
    if (event.stream === undefined) reject(new Error('Chromium tracing did not return an evidence stream.'));
    else resolve(event.stream);
  };
  const result = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
  session.once('Tracing.tracingComplete', finished);
  timer = setTimeout(() => {
    session.off('Tracing.tracingComplete', finished);
    reject(new Error('Chromium trace completion timed out.'));
  }, 15_000);
  return { result, cancel: () => { clearTimeout(timer); session.off('Tracing.tracingComplete', finished); } };
};

const saveTrace = async (session: CDPSession, stream: string, path: string): Promise<void> => {
  let failure: unknown;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, 'w');
    let eof = false;
    while (!eof) {
      const chunk = await session.send('IO.read', { handle: stream, size: 262_144 });
      await file.writeFile(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data, 'utf8'));
      eof = chunk.eof;
    }
  } catch (error) { failure = error; }
  try { if (file !== undefined) await file.close(); }
  catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Trace streaming and file closure failed.'); }
  try { await session.send('IO.close', { handle: stream }); }
  catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Trace streaming and Chromium stream closure failed.'); }
  if (failure !== undefined) throw failure;
};

export const withCapacityTrace = async <T>(page: Page, info: TestInfo, name: string, operation: () => Promise<T>): Promise<T> => {
  const session = await page.context().newCDPSession(page);
  let result!: T;
  let failure: unknown;
  try {
    await session.send('Tracing.start', { categories, transferMode: 'ReturnAsStream', streamFormat: 'json', streamCompression: 'none' });
    try { result = await operation(); } catch (error) { failure = error; }
    const completion = complete(session);
    try {
      const [, stream] = await Promise.all([session.send('Tracing.end'), completion.result]);
      const path = info.outputPath(`${name}-chromium-trace.json`);
      await saveTrace(session, stream, path);
      await info.attach(`${name}-chromium-trace`, { path, contentType: 'application/json' });
    } finally { completion.cancel(); }
  } catch (error) {
    failure = failure === undefined ? error : new AggregateError([failure, error], 'Capacity interaction and Chromium tracing failed.');
  } finally {
    try { await session.detach(); }
    catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Capacity tracing and CDP session closure failed.'); }
  }
  if (failure !== undefined) throw failure;
  return result;
};
