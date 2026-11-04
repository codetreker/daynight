import { spawn, type ChildProcess } from 'node:child_process';

export type CommandOptions = {
  cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; quiet?: boolean; signal?: AbortSignal;
  input?: string | Uint8Array;
  forceAfterMs?: number; onOutput?: (chunk: string) => void;
  onSpawn?: (child: ChildProcess) => void | Promise<void>;
};
export type CommandBytes = { stdout: Buffer; stderr: Buffer; exitCode: number };
export const terminateGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
};

const capture = async (file: string, args: readonly string[], options: CommandOptions, raw: boolean): Promise<CommandBytes> => {
  options.signal?.throwIfAborted();
  return await new Promise<CommandBytes>((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? process.env, detached: true, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let failure: unknown;
    let closed = false;
    let settled = false;
    let registration = Promise.resolve();
    let rejectStopped: (cause: unknown) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
    void stopped.catch(() => {});
    const stop = (error: unknown): void => {
      if (settled) return;
      failure ??= error;
      rejectStopped(failure);
      if (closed) return;
      terminateGroup(child, 'SIGTERM');
      forceTimer ??= setTimeout(() => terminateGroup(child, 'SIGKILL'), options.forceAfterMs ?? 5_000);
    };
    child.once('spawn', () => {
      try { registration = Promise.resolve(options.onSpawn?.(child)); }
      catch (error) { registration = Promise.reject(error); }
      void registration.catch(stop);
    });
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => stop(new Error(`Acceptance command timed out: ${file}`)), options.timeoutMs ?? 60_000);
    const abort = (): void => stop(new Error('Acceptance command cancelled.', { cause: options.signal?.reason }));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.input !== undefined) {
      child.stdin!.once('error', stop);
      child.stdin!.end(options.input);
    }
    const collect = (data: Buffer, target: Buffer[]): void => {
      bytes += data.length;
      if (bytes > 8 * 1024 * 1024) stop(new Error('Acceptance command exceeded its bounded output.'));
      else target.push(data);
    };
    child.stdout!.on('data', (data: Buffer) => {
      if (!raw) {
        options.onOutput?.(data.toString('utf8'));
        if (!options.quiet) process.stdout.write(data);
      }
      collect(data, output);
    });
    child.stderr!.on('data', (data: Buffer) => {
      if (!raw && !options.quiet) process.stderr.write(data);
      collect(data, errors);
    });
    child.once('error', (error) => { failure ??= error; });
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(forceTimer);
      void (async () => {
        try {
          await Promise.race([registration, stopped]);
          if (failure !== undefined) throw failure;
          if (code === null) throw new Error(`Acceptance command exited by signal: ${file} (signal=${signal})`);
          resolve({ stdout: Buffer.concat(output), stderr: Buffer.concat(errors), exitCode: code });
        } catch (error) { reject(error); }
        finally {
          settled = true;
          clearTimeout(timer);
          clearTimeout(forceTimer);
          options.signal?.removeEventListener('abort', abort);
        }
      })();
    });
  });
};

export const commandBytes = async (file: string, args: readonly string[], options: Omit<CommandOptions, 'quiet' | 'onOutput'>): Promise<CommandBytes> =>
  await capture(file, args, options, true);

export const command = async (file: string, args: readonly string[], options: CommandOptions): Promise<string> => {
  const result = await capture(file, args, options, false);
  if (result.exitCode !== 0) throw new Error(`Acceptance command failed: ${file} (exit=${result.exitCode}, signal=null)`);
  return result.stdout.toString('utf8').trim();
};
