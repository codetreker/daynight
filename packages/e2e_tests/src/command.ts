import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:os';

export type CommandOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  onOutput?: (channel: 'stdout' | 'stderr', chunk: string) => void;
  stdin?: 'pipe';
  stopOwnedGroup?: (pid: number) => Promise<void>;
};

export type CommandResult = { stdout: string; stderr: string; exitCode: number };
export type ManagedCommand = {
  readonly pid: number;
  finished: Promise<CommandResult>;
  stopProcesses: () => Promise<void>;
  writeInput: (data: string) => Promise<void>;
  endInput: () => void;
  stop: () => Promise<void>;
};

export class CommandFailure extends Error {
  readonly result: CommandResult;
  constructor(command: string, result: CommandResult) {
    super(`Command failed: ${command} (exit=${result.exitCode})\n${result.stderr || result.stdout}`);
    this.name = 'CommandFailure';
    this.result = result;
  }
}
export class CommandStopUnconfirmedError extends Error {
  constructor(cause: unknown) { super('Command process stop was not confirmed.', { cause }); this.name = 'CommandStopUnconfirmedError'; }
}
export class CommandTimeoutError extends Error {
  constructor(timeoutMs: number, command: string) { super(`Command timed out after ${timeoutMs}ms: ${command}`); this.name = 'CommandTimeoutError'; }
}

const outputLimit = 1024 * 1024;
const graceMs = 500;
const closeDeadlineMs = 5_000;
let activeCommands = 0;
let unconfirmedCommand = false;
export const markCommandOutcomeUnconfirmed = (): void => { unconfirmedCommand = true; };
export const assertCommandQuiescence = (): void => {
  if (activeCommands !== 0 || unconfirmedCommand) throw new Error('Command lifecycle or external request outcome remains unconfirmed.');
};
const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

const signalGroup = (pid: number, signal: NodeJS.Signals | 0): boolean => {
  try { process.kill(-pid, signal); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
};

const groupIsActive = async (pid: number): Promise<boolean> => {
  const entries = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry));
  const members = await Promise.all(entries.map(async (entry): Promise<boolean> => {
    try {
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return Number(fields[2]) === pid && fields[0] !== 'Z' && fields[0] !== 'X';
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')) return false;
      throw error;
    }
  }));
  return members.some(Boolean);
};

const waitForClose = async (closed: Promise<void>): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Command pipes did not close after process-group termination.')), closeDeadlineMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
};

// Completion includes descendant cleanup even when the command itself succeeds.
// Explicit stop resolves with the observed exit status; abort and timeout reject.
export const startCommand = (command: string, args: readonly string[], options: CommandOptions): ManagedCommand => {
  if (process.platform !== 'linux') throw new Error('The product E2E command runner requires Linux.');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('Command timeoutMs must be a positive finite number.');
  options.signal?.throwIfAborted();

  const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: [options.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  activeCommands++;
  const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const failures: unknown[] = [];
  let settled = false;
  let teardown: Promise<void> | undefined;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let resolveExit: (result: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveExit = resolve; });

  const stopGroup = (): Promise<void> => {
    if (teardown !== undefined) return teardown;
    teardown = (async () => {
      if (child.pid !== undefined && options.stopOwnedGroup !== undefined) {
        await options.stopOwnedGroup(child.pid);
      } else if (child.pid !== undefined && signalGroup(child.pid, 'SIGTERM')) {
        const deadline = performance.now() + graceMs;
        while (signalGroup(child.pid, 0) && performance.now() < deadline) await delay(20);
        signalGroup(child.pid, 'SIGKILL');
        // Orphaned zombies can retain a process group after execution has ended.
        const stoppedDeadline = performance.now() + closeDeadlineMs;
        while (await groupIsActive(child.pid)) {
          if (performance.now() >= stoppedDeadline) throw new Error(`Command process group remained active after SIGKILL: ${child.pid}`);
          await delay(20);
        }
      }
      await waitForClose(closed);
    })().catch((cause) => { unconfirmedCommand = true; throw new CommandStopUnconfirmedError(cause); });
    // Keep cleanup failures in the completion result while callers await output.
    void teardown.catch((error) => { failures.push(error); });
    return teardown;
  };

  const fail = (error: unknown): void => {
    if (settled) return;
    unconfirmedCommand = true;
    failures.push(error);
    void stopGroup();
  };

  const collect = (channel: 'stdout' | 'stderr', data: Buffer): void => {
    const previous = output[channel];
    output[channel] = data.length >= outputLimit
      ? Buffer.from(data.subarray(data.length - outputLimit))
      : Buffer.concat([previous.subarray(Math.max(0, previous.length + data.length - outputLimit)), data]);
    try {
      if (options.onOutput !== undefined) options.onOutput(channel, data.toString('utf8'));
      else process[channel].write(data);
    } catch (error) { fail(error); }
  };
  child.stdin?.on('error', fail);
  child.stdout!.on('data', (data: Buffer) => collect('stdout', data));
  child.stderr!.on('data', (data: Buffer) => collect('stderr', data));
  child.stdout!.once('error', fail);
  child.stderr!.once('error', fail);
  child.once('error', fail);
  child.once('exit', (code, signal) => {
    resolveExit({ code, signal });
    void stopGroup();
  });
  child.once('close', (code, signal) => {
    resolveExit({ code, signal });
    resolveClosed();
  });

  const abort = (): void => {
    unconfirmedCommand = true;
    const reason = options.signal!.reason;
    fail(reason instanceof Error ? reason : new Error('Command cancelled.', { cause: reason }));
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { unconfirmedCommand = true; fail(new CommandTimeoutError(options.timeoutMs, command)); }, options.timeoutMs);

  const finished = (async (): Promise<CommandResult> => {
    const result = await exited;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    try { await stopGroup(); }
    catch (error) { if (!failures.includes(error)) failures.push(error); }
    settled = true;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `Command execution or cleanup failed: ${command}`, { cause: failures[0] });
    if (result.code === null && result.signal === null) throw new Error(`Command exited without a status: ${command}`);
    const signalCode = result.signal === null ? undefined : constants.signals[result.signal];
    if (result.code === null && signalCode === undefined) throw new Error(`Command exited with an unknown signal: ${command} (${result.signal})`);
    const exitCode = result.code === null ? 128 + signalCode! : result.code;
    return { stdout: output.stdout.toString('utf8'), stderr: output.stderr.toString('utf8'), exitCode };
  })();
  // The same promise remains rejectable when the owner observes it later.
  void finished.catch(() => {});
  void finished.then(() => { activeCommands--; }, () => { activeCommands--; });

  return {
    get pid(): number {
      if (child.pid === undefined) throw new Error(`Command did not spawn: ${command}`);
      return child.pid;
    },
    finished,
    stopProcesses: stopGroup,
    endInput: () => { child.stdin?.end(); },
    writeInput: async (data: string): Promise<void> => {
      if (child.stdin === null) throw new Error('Command input is unavailable.');
      await new Promise<void>((resolve, reject) => child.stdin!.write(data, (error) => error ? reject(error) : resolve()));
    },
    stop: async (): Promise<void> => {
      await stopGroup();
      await finished;
    },
  };
};

export const runCommand = async (command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> => {
  const result = await startCommand(command, args, options).finished;
  if (result.exitCode !== 0) {
    if (command === 'docker') unconfirmedCommand = true;
    throw new CommandFailure(command, result);
  }
  return result;
};
