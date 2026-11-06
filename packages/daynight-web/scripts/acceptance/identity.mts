import { readFile, readlink, readdir, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { darwinArguments, darwinFind, darwinIdentity } from './process-darwin.mts';

export type ProcessIdentity = { platform: 'linux' | 'darwin'; pid: number; executable: string; startTicks: string; group: number };
const validatePid = (pid: number): void => {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 2_147_483_647) throw new Error('Invalid acceptance process identity.');
};
const requirePlatform = (): void => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('Process recovery requires Linux or macOS process identity support.');
};
const absent = (error: unknown): boolean => error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH');
const linuxStat = async (pid: number): Promise<{ startTicks: string; group: number }> => {
  const value = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = value.slice(value.lastIndexOf(')') + 2).split(' ');
  const startTicks = fields[19]; const group = Number(fields[2]);
  if (startTicks === undefined || !/^\d+$/.test(startTicks) || !Number.isSafeInteger(group) || group <= 0) throw new Error('Invalid Linux process start identity.');
  return { startTicks, group };
};
export const processIdentity = async (pid: number): Promise<ProcessIdentity | null> => {
  validatePid(pid); requirePlatform();
  if (process.platform === 'darwin') return await darwinIdentity(pid);
  try {
    const before = await linuxStat(pid);
    const executable = await readlink(`/proc/${pid}/exe`);
    const after = await linuxStat(pid);
    if (before.startTicks !== after.startTicks || before.group !== after.group) throw new Error('Linux process identity changed during inspection.');
    return { platform: 'linux', pid, executable, ...after };
  } catch (error) { if (absent(error)) return null; throw error; }
};
export const processArguments = async (pid: number): Promise<string[] | null> => {
  validatePid(pid); requirePlatform();
  if (process.platform === 'darwin') return await darwinArguments(pid);
  try {
    const before = await processIdentity(pid);
    if (before === null) return null;
    const bytes = await readFile(`/proc/${pid}/cmdline`);
    const after = await processIdentity(pid);
    if (after === null) return null;
    if (!sameProcess(before, after)) throw new Error('Linux process changed during argument inspection.');
    if (bytes.length === 0) throw new Error('Linux process arguments are inaccessible.');
    const arguments_ = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\0');
    if (arguments_.pop() !== '') throw new Error('Invalid Linux process arguments.');
    return arguments_;
  } catch (error) { if (absent(error)) return null; throw error; }
};
export const findProcesses = async (environment: Record<string, string>): Promise<ProcessIdentity[]> => {
  requirePlatform();
  const markers = Object.entries(environment);
  if (markers.length === 0 || markers.some(([key, value]) => key.length === 0 || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0'))
    || Buffer.byteLength(markers.map(([key, value]) => `${key}=${value}\0`).join('')) >= 1024 * 1024) throw new Error('Invalid process environment markers.');
  if (process.platform === 'darwin') return await darwinFind(environment);
  const result: ProcessIdentity[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) <= 1) continue;
    const pid = Number(entry);
    try {
      // Another user's processes cannot be children of this acceptance invocation.
      if (process.getuid !== undefined && (await stat(`/proc/${entry}`)).uid !== process.getuid()) continue;
      const before = await linuxStat(pid);
      let environmentBytes: Buffer;
      try { environmentBytes = await readFile(`/proc/${entry}/environ`); }
      catch (error) {
        // Non-dumpable unrelated processes can hide their environment even from the same UID.
        if (error instanceof Error && 'code' in error && error.code === 'EACCES') continue;
        throw error;
      }
      const values = environmentBytes.toString().split('\0');
      if (!markers.every(([key, value]) => values.includes(`${key}=${value}`))) continue;
      const identity = await processIdentity(pid);
      if (identity === null) continue;
      if (before.startTicks !== identity.startTicks || before.group !== identity.group) throw new Error('Owned Linux process changed during discovery.');
      result.push(identity);
    } catch (error) { if (!absent(error)) throw error; }
  }
  return result;
};
export const sameProcess = (expected: ProcessIdentity, observed: ProcessIdentity | null): boolean =>
  observed !== null && expected.platform === observed.platform && expected.pid === observed.pid && expected.group === observed.group
  && expected.executable === observed.executable && expected.startTicks === observed.startTicks;
export const requireStopped = async (identity: ProcessIdentity): Promise<void> => {
  if (identity.platform !== process.platform) throw new Error('Acceptance process receipt platform differs from this host.');
  const observed = await processIdentity(identity.pid);
  if (observed !== null && observed.startTicks === identity.startTicks) throw new Error('Original acceptance process is still running; recovery refused.');
};
export const ownedBrowserProcesses = async (directory: string, executables: readonly string[]): Promise<ProcessIdentity[]> =>
  (await findProcesses({ DAYNIGHT_ACCEPTANCE_DIRECTORY: directory })).filter((identity) => executables.includes(identity.executable));
export const isGroupStopped = (pid: number): boolean => {
  validatePid(pid); requirePlatform();
  try { process.kill(-pid, 0); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true;
    throw error;
  }
  return false;
};

export const requireGroupStopped = (pid: number): void => {
  if (!isGroupStopped(pid)) throw new Error('Original acceptance process group is still running; recovery refused.');
};

export const waitForGroupStopped = async (pid: number, timeoutMs = 3_000): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try { if (isGroupStopped(pid)) return; }
    catch (error) {
      // macOS may report EPERM while the last member exits; only ESRCH proves absence.
      if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error;
    }
    await delay(10);
  }
  requireGroupStopped(pid);
};
