import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readlink, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { findProcesses, processArguments, processIdentity, sameProcess } from './validation/identity.mts';
import type { CommandOptions } from './validation/process.mts';

const root = fileURLToPath(new URL('../', import.meta.url));
const execFileAsync = promisify(execFile);

// Each configuration owns its host, routes and browser context. Run them in
// sequence because several hosts use the same fixed loopback port.
export const browserConfigs = [
  'playwright.config.ts',
  'team-playwright.config.ts',
  'discussion-identity-playwright.config.ts',
  'team-management-identity-playwright.config.ts',
  'project-grants-playwright.config.ts',
  'github-settings-playwright.config.ts',
  'project-settings-workspace-playwright.config.ts',
  'project-transfer-playwright.config.ts',
  'project-withdrawal-playwright.config.ts',
  'project-deletion-layout-playwright.config.ts',
  'attachment-browser-playwright.config.ts',
  'task-controls-playwright.config.ts',
  'graph-browser-playwright.config.ts',
  'pr-detail-browser-playwright.config.ts',
  'pr-list-browser-playwright.config.ts',
  'my-tasks-browser-playwright.config.ts',
  'markdown-browser-playwright.config.ts',
  'claim-reading-playwright.config.ts',
  'task-reading-playwright.config.ts',
  'task-tags-playwright.config.ts',
  'goal-reading-playwright.config.ts',
  'identity-cache-playwright.config.ts',
  'locale-continuity-playwright.config.ts',
  'landing-header-playwright.config.ts',
  'setup-guide-playwright.config.ts',
  'native-select-playwright.config.ts',
  'create-project-mobile-playwright.config.ts',
  'task-view-continuity-playwright.config.ts',
  'project-tags-playwright.config.ts',
  'graph-visibility-browser-playwright.config.ts',
  'team-invitation-browser-playwright.config.ts',
  'graph-direction-browser-playwright.config.ts',
  'session-header-playwright.config.ts',
  'session-images-playwright.config.ts',
  'session-drafts-playwright.config.ts',
  'session-column-playwright.config.ts',
  'session-keyboard-playwright.config.ts',
  'session-record-layout-playwright.config.ts',
  'worker-configuration-navigation-playwright.config.ts',
  'worker-tool-paths-playwright.config.ts',
  'bots-viewport-playwright.config.ts',
] as const;

// Playwright starts its webServer in a separate process group. Its inherited,
// per-invocation marker identifies only processes owned by this command.
const stopOwned = async (marker: Record<string, string>): Promise<void> => {
  const start = performance.now();
  while (true) {
    const processes = await findProcesses(marker);
    if (processes.length === 0) return;
    if (performance.now() - start > 8_000) throw new Error('Browser command processes did not stop.');
    for (const identity of processes) {
      if (!sameProcess(identity, await processIdentity(identity.pid))) continue;
      try { process.kill(identity.pid, performance.now() - start < 3_000 ? 'SIGTERM' : 'SIGKILL'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
    }
    await delay(50);
  }
};

const browserPids = async (directory: string, windows: boolean, cwd: string): Promise<number[]> => {
  if (windows) {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains("--user-data-dir=") -and $_.CommandLine.Contains($env:DAYNIGHT_BROWSER_PROFILE) } | ForEach-Object { $_.ProcessId }'],
    { env: { ...process.env, DAYNIGHT_BROWSER_PROFILE: directory }, timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return stdout.split(/\s+/).filter(Boolean).map(Number);
  }
  const { stdout } = await execFileAsync('ps', ['-ww', '-axo', 'pid=,args='], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match && match[2]!.includes('--user-data-dir=') && (match[2]!.includes(directory) || match[2]!.includes(path.relative(cwd, directory))) ? [Number(match[1])] : [];
  });
};

const liveGroupPids = async (group: number): Promise<number[]> => {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,pgid=,stat='], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    return match && Number(match[2]) === group && !match[3]!.startsWith('Z') ? [Number(match[1])] : [];
  });
};

const processCwd = async (pid: number): Promise<string> => {
  if (process.platform === 'linux') return await readlink(`/proc/${pid}/cwd`);
  const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 10_000 });
  const entry = stdout.split('\n').find(line => line.startsWith('n'));
  if (entry === undefined) throw new Error('Browser working directory is unverified.');
  return entry.slice(1);
};

const profileOwner = async (pid: number, profileRoot: string) => {
  const identity = await processIdentity(pid);
  if (identity === null) return null;
  const args = await processArguments(pid);
  if (args === null) return null;
  const cwd = await processCwd(pid);
  if (!sameProcess(identity, await processIdentity(pid))) throw new Error('Browser process changed during profile inspection.');
  const canonicalRoot = await realpath(profileRoot);
  let owned = false;
  for (const arg of args) {
    if (!arg.startsWith('--user-data-dir=')) continue;
    const candidate = path.resolve(cwd, arg.slice('--user-data-dir='.length));
    const inside = (value: string): boolean => {
      const relative = path.relative(canonicalRoot, value);
      return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
    };
    if (!inside(candidate)) continue;
    if (!inside(await realpath(candidate))) throw new Error('Browser profile resolves outside its invocation directory; cleanup refused.');
    owned = true;
  }
  return owned ? { identity, cwd } : null;
};

const stopBrowserGroup = async (pid: number, profileRoot: string): Promise<boolean> => {
  const owner = await profileOwner(pid, profileRoot);
  if (owner === null) return false;
  const { identity, cwd } = owner;
  if (identity.group !== identity.pid || !sameProcess(identity, await processIdentity(pid))) throw new Error('Browser process identity or group changed; cleanup refused.');
  const members = await Promise.all((await liveGroupPids(identity.group)).map(processIdentity));
  const observed = await profileOwner(pid, profileRoot);
  if (observed === null || observed.cwd !== cwd || !sameProcess(identity, observed.identity)) throw new Error('Browser group leader or profile changed; cleanup refused.');
  try { process.kill(-identity.group, 'SIGTERM'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
  await delay(500);
  for (const member of members) {
    if (member === null || !sameProcess(member, await processIdentity(member.pid))) continue;
    try { process.kill(member.pid, 'SIGKILL'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
  }
  const deadline = performance.now() + 5_000;
  while ((await liveGroupPids(identity.group)).length > 0 && performance.now() < deadline) await delay(50);
  if ((await liveGroupPids(identity.group)).length > 0) throw new Error('Browser process group is still running or its identity is unverified.');
  return true;
};

export const runBrowserCommand = async (file: string, args: readonly string[], options: CommandOptions,
  operations = { stopOwned }): Promise<string> => {
  options.signal?.throwIfAborted();
  const windows = process.platform === 'win32';
  const environment = { ...process.env, ...options.env };
  let taskkill: string | undefined;
  if (windows) {
    const systemRoot = Object.entries(environment).find(([name]) => name.toLowerCase() === 'systemroot')?.[1];
    if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) throw new Error('SystemRoot must identify the Windows installation directory.');
    taskkill = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
    if (!(await stat(taskkill)).isFile()) throw new Error('Windows taskkill.exe is unavailable.');
  }
  const marker = { DAYNIGHT_WEB_BROWSER_RUN: randomUUID() };
  const temporary = path.join(root, '.tmp');
  await mkdir(temporary, { recursive: true });
  const profileRoot = await mkdtemp(path.join(temporary, 'browser-run-'));
  const childTmp = windows ? profileRoot : path.relative(options.cwd, profileRoot);
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: { ...environment, ...marker, TMPDIR: childTmp, TMP: childTmp, TEMP: childTmp }, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let failure: unknown;
    let forceTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let termination: Promise<void> | undefined;
    let cleanup: Promise<void> | undefined;
    let leaderIdentity: ReturnType<typeof processIdentity> | undefined;
    const stop = (reason: Error): void => {
      if (failure !== undefined) return;
      failure = reason;
      if (child.pid === undefined) return;
      drainTimer = setTimeout(() => {
        failure = new AggregateError([failure], 'Browser process did not drain; detached descendants may be unverified.');
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        void beginCleanup().finally(() => reject(failure));
      }, 15_000);
      if (windows) {
        termination = new Promise((done, fail) => {
          const killer = spawn(taskkill!, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
          killer.once('error', fail);
          killer.once('close', code => code === 0 ? done() : fail(new Error(`Windows taskkill failed: ${String(code)}.`)));
        });
        void termination.catch(() => {});
      } else {
        // Playwright owns the browser and preview; let it close them first.
        child.kill('SIGINT');
        forceTimer = setTimeout(() => {
          termination = (async () => {
            const identity = await leaderIdentity;
            if (identity !== null && identity !== undefined && sameProcess(identity, await processIdentity(identity.pid))) {
              try { process.kill(-identity.pid, 'SIGKILL'); }
              catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
            }
            await operations.stopOwned(marker);
            throw new Error('Forced browser termination: detached descendants without the invocation marker may be unverified.');
          })();
          void termination.catch(() => {});
        }, 5_000);
      }
    };
    const abort = (): void => stop(new Error('Browser command cancelled.'));
    const timer = setTimeout(() => stop(new Error('Browser command timed out.')), options.timeoutMs ?? 1_800_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once('spawn', () => {
      if (!windows && child.pid !== undefined) {
        leaderIdentity = processIdentity(child.pid);
        void leaderIdentity.catch(() => {});
      }
      try { void Promise.resolve(options.onSpawn?.(child)).catch(error => stop(new Error('Browser command registration failed.', { cause: error }))); }
      catch (error) { stop(new Error('Browser command registration failed.', { cause: error })); }
    });
    child.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString('utf8'); output += chunk; options.onOutput?.(chunk);
      if (!options.quiet) process.stdout.write(data);
      if (Buffer.byteLength(output) > 8 * 1024 * 1024) stop(new Error('Browser command exceeded its bounded output.'));
    });
    child.stderr.on('data', (data: Buffer) => { if (!options.quiet) process.stderr.write(data); });
    child.once('error', error => { failure ??= error; });
    const beginCleanup = (): Promise<void> => {
      cleanup ??= (async () => {
        const recordCleanupFailure = (error: unknown): void => {
          failure = failure === undefined ? error : new AggregateError([failure, error], 'Browser command and cleanup failed.', { cause: failure });
        };
        let terminationConfirmed = true;
        try { await termination; } catch (error) { terminationConfirmed = false; recordCleanupFailure(error); }
        let markerStopped = true;
        try { if (!windows) await operations.stopOwned(marker); }
        catch (error) { markerStopped = false; recordCleanupFailure(error); }
        try {
          const ownedBrowsers = async (): Promise<number[]> => {
            const candidates = await browserPids(profileRoot, windows, options.cwd);
            if (windows) return candidates;
            const owners = await Promise.all(candidates.map(pid => profileOwner(pid, profileRoot)));
            return candidates.filter((_pid, index) => owners[index] !== null);
          };
          const browsers = await ownedBrowsers();
          if (browsers.length > 0) {
            if (windows) {
              throw new Error('A browser using this command\'s profile survived Playwright; Windows process identity cannot be verified for cleanup.');
            } else {
              for (const pid of browsers) await stopBrowserGroup(pid, profileRoot);
            }
            const deadline = performance.now() + 5_000;
            while ((await ownedBrowsers()).length > 0 && performance.now() < deadline) await delay(50);
            if ((await ownedBrowsers()).length > 0) throw new Error('A browser using this command\'s profile is still running; cleanup is unverified.');
            if (markerStopped && terminationConfirmed) await rm(profileRoot, { recursive: true, force: true });
            throw new Error('A browser using this command\'s profile survived Playwright and was stopped.');
          }
          if (markerStopped && terminationConfirmed) await rm(profileRoot, { recursive: true, force: true });
        }
        catch (error) { recordCleanupFailure(error); }
        if (!markerStopped || !terminationConfirmed) recordCleanupFailure(new Error(`Browser temporary directory retained because cleanup is unverified: ${profileRoot}`));
      })();
      return cleanup;
    };
    child.once('exit', (code, signal) => {
      clearTimeout(timer); clearTimeout(forceTimer); options.signal?.removeEventListener('abort', abort);
      if (failure === undefined && code !== 0) failure = new Error(`Browser command failed: exit=${String(code)}, signal=${String(signal)}. Detached descendants may be unverified.`);
      void beginCleanup();
    });
    child.once('close', () => {
      void (async () => {
        clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(drainTimer); options.signal?.removeEventListener('abort', abort);
        await beginCleanup();
        if (failure !== undefined) reject(failure); else resolve(output.trim());
      })();
    });
  });
};

type Operations = { command: (file: string, args: readonly string[], options: CommandOptions) => Promise<string> };
export const runBrowser = async (cancellation: AbortController, operations: Operations = { command: runBrowserCommand }): Promise<void> => {
  for (const config of browserConfigs) {
    cancellation.signal.throwIfAborted();
    await operations.command(process.execPath, [fileURLToPath(import.meta.resolve('@playwright/test/cli')), 'test', '--config', `tests/navigation/${config}`], {
      cwd: root, signal: cancellation.signal, timeoutMs: 1_800_000,
    });
  }
};

const main = async (): Promise<void> => {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/browser.mts');
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try { await runBrowser(cancellation); }
  finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
};

if (import.meta.main) {
  try { await main(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
