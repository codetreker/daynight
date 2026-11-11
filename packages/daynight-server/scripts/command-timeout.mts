import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { signalCommandGroup } from './command-process-group.mts';

const [duration, grace, command, ...args] = process.argv.slice(2);
const milliseconds = (value: string | undefined): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new Error('Command deadlines must be positive milliseconds within the timer range.');
  }
  return parsed;
};

try {
  const timeoutMs = milliseconds(duration);
  const graceMs = milliseconds(grace);
  if (!command || process.platform === 'win32') throw new Error('Usage on Linux or macOS: node scripts/command-timeout.mts TIMEOUT_MS GRACE_MS COMMAND [ARGUMENT...]');
  const child = spawn(command, args, { stdio: 'inherit', detached: true });
  let interrupted: number | undefined;
  let failed = false;
  let escalation: NodeJS.Timeout | undefined;
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try { signalCommandGroup(child.pid, signal); }
    catch (error) {
      failed = true;
      console.error('Unable to terminate the owned command process group:', error);
    }
  };
  const stop = (code: number): void => {
    if (interrupted !== undefined) return;
    interrupted = code;
    signalGroup('SIGTERM');
    escalation = setTimeout(() => signalGroup('SIGKILL'), graceMs);
  };
  const interrupt = (): void => stop(130);
  const terminate = (): void => stop(143);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  const deadline = setTimeout(() => {
    console.error(`Validation command exceeded ${timeoutMs}ms: ${command}`);
    stop(124);
  }, timeoutMs);
  child.once('error', (error) => {
    failed = true;
    console.error('Unable to run validation command:', error);
  });
  child.once('close', (code, signal) => {
    // The leader may exit on TERM while a descendant ignores it. Keep ownership
    // through group termination instead of cancelling escalation at leader exit.
    signalGroup('SIGKILL');
    clearTimeout(deadline);
    clearTimeout(escalation);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    process.exitCode = failed ? 125 : interrupted ?? code ?? 128 + constants.signals[signal!];
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 125;
}
