import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { command, type CommandOptions } from './process.mts';
import { aggregateScenarios, readReport } from './report.mts';
import { validatePerformance } from './performance.mts';
import { processIdentity, requireGroupStopped, requireStopped, sameProcess, type ProcessIdentity } from './identity.mts';
import { browserInventory, recoverBrowsers } from './browser.mts';
import { waitForContainerPermission, writeContainerPermission } from './permission.mts';
import { runPipeline, runTargetPipeline } from './pipeline.mts';
import { browserDirectories, capacityScenarios, expectedTargets, functionalScenarios, readAcceptanceScope, type AcceptanceScope } from './inventory.mts';
import { recordAcceptanceCompletion } from './completion.mts';
import { acceptanceEvidenceSchemaVersion, nativeEvidence, readEvidenceHeader, validateEvidenceScope, type Source, type Target, type BrowserPhase, type Stage, type NativeEvidence, type AuthFixtureEvidence, type InstalledEvidence, type ReadyInstalledEvidence, type Evidence } from './evidence.mts';
import type { PackedCliPackage } from '../../../daynight/test/fixtures/installed-cli.ts';
import { prepareStorage, cleanupStorage, type StorageReceipt } from './storage.mts';
import { recoverCliProcesses, validateInstalledCli, type InstalledCliReceipt } from './installed-cli.mts';
import { reserveLoopbackPort, startAuthFixture, type AuthFixture } from './auth-fixture.mts';
import { runAuthCombined, validateAuthCombinedReceipt, type AuthCombinedReceipt, type RestartReceipt } from './auth-combined.mts';
import type { CombinedCommand, CombinedTarget } from './auth-combined-target.mts';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const repositoryRoot = resolve(packageRoot, '../..');
const serverRoot = resolve(packageRoot, '../daynight-server');
const evidenceRoot = join(packageRoot, '.tmp/acceptance');
const privateRoot = join(packageRoot, '.tmp/acceptance-private');
const script = fileURLToPath(new URL('../acceptance.mts', import.meta.url));
const labelKey = 'io.daynight.acceptance.run';

const json = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.next`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${path}.next`, path);
};
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
export type AcceptanceCommand = (file: string, args: readonly string[], options?: Omit<CommandOptions, 'cwd'> & { cwd?: string }) => Promise<string>;
export type AcceptanceOptions = { scope?: AcceptanceScope; packedPackage?: PackedCliPackage; allowApfsImage?: boolean };

type InstalledPreparation = { receipt: InstalledCliReceipt; receiptPath: string; cleanup(): Promise<void> };
type InstalledFactoryOptions = { signal: AbortSignal; temporaryRoot: string; rootDirectory: string; packedPackage?: PackedCliPackage; onSpawn(child: ChildProcess): Promise<void> };
const prepareInstalledCli = async (options: InstalledFactoryOptions): Promise<InstalledPreparation> => {
  const fixture = await import(new URL('../../../daynight/test/fixtures/installed-cli.ts', import.meta.url).href) as Record<string, unknown>;
  if (typeof fixture.createInstalledCli !== 'function') throw new Error('The installed CLI preparation fixture is unavailable.');
  const create = fixture.createInstalledCli as (options: InstalledFactoryOptions) => Promise<InstalledPreparation>;
  return await create(options);
};

class NativeAddressInUseError extends Error {}

const sameBrowser = (combined: AuthCombinedReceipt, original: unknown): void => {
  const previous = original as { name: string; version: string; platform: string; executableOverride: boolean };
  if (combined.browser === undefined || combined.browser.name !== previous.name || combined.browser.version !== previous.version
    || combined.browser.platform !== previous.platform || combined.browser.executableOverride !== previous.executableOverride) throw new Error('Combined browser differs from its normal target phase.');
};

export const restartContainerServer = async (options: {
  containerId: string; imageId: string; project: string; origin: string; signal: AbortSignal; run: CombinedCommand;
  record(value: Omit<RestartReceipt, 'readyAt'> & { readyAt?: string }): Promise<void>;
}): Promise<RestartReceipt> => {
  if (!/^[a-f0-9]{64}$/.test(options.containerId) || !/^sha256:[a-f0-9]{64}$/.test(options.imageId)
    || !/^daynight-dev-ci-\d{14}-\d+-\d{5}$/.test(options.project) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(options.origin)) throw new Error('Invalid owned container restart.');
  const inspect = async () => {
    const result = await options.run('docker', ['inspect', '--format', '{{.State.Pid}}|{{.State.StartedAt}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Running}}', options.containerId], { quiet: true, timeoutMs: 10_000 });
    const [pid, start, image, project, service, running] = result.split('|');
    if (!/^[1-9]\d*$/.test(pid!) || !Number.isSafeInteger(Number(pid)) || !/^\d{4}-\d{2}-\d{2}T/.test(start!)
      || image !== options.imageId || project !== options.project || service !== 'server' || running !== 'true') throw new Error('Container restart ownership or runtime differs.');
    return { pid: Number(pid), start: start! };
  };
  const before = await inspect();
  const startedAt = new Date().toISOString();
  await options.record({ target: 'container', origin: options.origin, startedAt, before, after: before, binaryOrImage: options.imageId, containerId: options.containerId });
  const id = await options.run('docker', ['restart', '--timeout', '20', options.containerId], { quiet: true, timeoutMs: 30_000 });
  if (id !== options.containerId) throw new Error('Container restart replaced its owned identity.');
  const after = await inspect();
  if (after.pid === before.pid || after.start === before.start) throw new Error('Container restart did not replace the service process.');
  const receipt = { target: 'container' as const, origin: options.origin, startedAt, before, after, binaryOrImage: options.imageId, containerId: options.containerId };
  await options.record(receipt);
  const deadline = performance.now() + 45_000;
  for (;;) {
    options.signal.throwIfAborted();
    let ready = false;
    try {
      const response = await fetch(`${options.origin}/readyz`, { signal: AbortSignal.any([options.signal, AbortSignal.timeout(1_000)]), redirect: 'error' });
      ready = response.status === 200; await response.arrayBuffer();
    } catch { options.signal.throwIfAborted(); }
    if (ready) break;
    if (performance.now() >= deadline) throw new Error('Restarted container readiness timed out.');
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const result = { ...receipt, readyAt: new Date().toISOString() }; await options.record(result); return result;
};

type NativeLaunchOptions = {
  binary: string; databaseUrl: string; storageRoot: string; baseUrl: string;
  auth: Pick<AuthFixture, 'origin' | 'appId' | 'appSecret'>; signal: AbortSignal;
  onSpawn(child: ChildProcess): Promise<void>;
  onUnexpectedExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void;
};

export const launchNativeServer = async (options: NativeLaunchOptions): Promise<ChildProcess> => {
  options.signal.throwIfAborted();
  const origin = new URL(options.baseUrl);
  if (origin.origin !== options.baseUrl || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.port === '') {
    throw new Error('Native acceptance requires an exact numeric loopback HTTP origin.');
  }
  await mkdir(options.storageRoot, { recursive: true });
  const child = spawn(options.binary, [], { cwd: serverRoot, env: { ...process.env,
    DAYNIGHT_DATABASE_URL: options.databaseUrl, DAYNIGHT_LISTEN_ADDR: origin.host, DAYNIGHT_STORAGE_ROOT: options.storageRoot,
    DAYNIGHT_PUBLIC_ORIGIN: origin.origin, DAYNIGHT_UNIAUTH_URL: options.auth.origin,
    DAYNIGHT_UNIAUTH_APP_ID: options.auth.appId, DAYNIGHT_UNIAUTH_APP_SECRET: options.auth.appSecret,
    DAYNIGHT_UNIAUTH_CALLBACK_URL: `${origin.origin}/api/v1/auth/callback`,
    DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN: '1', DAYNIGHT_ALLOW_LOOPBACK_HTTP: '1',
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let registration = Promise.resolve();
  let ready = false;
  let addressInUse = false;
  let partial = '';
  return await new Promise<ChildProcess>((resolveReady, reject) => {
    const finish = (): void => { clearTimeout(timer); options.signal.removeEventListener('abort', abort); };
    const fail = (error: unknown): void => { finish(); void registration.then(() => reject(error), reject); };
    const timer = setTimeout(() => fail(new Error('Native Go readiness timed out.')), 45_000);
    const abort = (): void => fail(new Error('Native Go startup cancelled.', { cause: options.signal.reason }));
    options.signal.addEventListener('abort', abort, { once: true });
    child.once('spawn', () => {
      try { registration = options.onSpawn(child); }
      catch (error) { registration = Promise.reject(error); }
      void registration.catch(fail);
    });
    child.once('error', fail);
    child.once('exit', (code, signal) => {
      finish();
      if (!ready) fail(addressInUse ? new NativeAddressInUseError('Native Go loopback port is already in use.') : new Error('Native Go process exited before readiness.'));
      else options.onUnexpectedExit(child, code, signal);
    });
    child.stderr!.on('data', (data: Buffer) => {
      partial += data.toString('utf8');
      if (partial.length > 65_536) { fail(new Error('Native Go emitted an oversized structured log line.')); return; }
      let boundary: number;
      while ((boundary = partial.indexOf('\n')) !== -1) {
        const line = partial.slice(0, boundary); partial = partial.slice(boundary + 1);
        let record: { phase?: unknown; address?: unknown; diagnostic?: unknown; cause?: unknown };
        try {
          const decoded: unknown = JSON.parse(line);
          if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('Invalid structured log.');
          record = decoded as typeof record;
        } catch { fail(new Error('Native Go emitted invalid structured logs.')); return; }
        if (record.phase === 'startup' && record.diagnostic === 'HTTP listen failed' && record.cause === 'address_in_use') addressInUse = true;
        if (record.phase === 'listening') {
          if (record.address !== origin.host) { fail(new Error('Native Go listener differs from its registered public origin.')); return; }
          ready = true; finish();
          void registration.then(() => {
            options.signal.throwIfAborted();
            if (child.exitCode !== null || child.signalCode !== null) throw new Error('Native Go exited while recording readiness.');
            resolveReady(child);
          }).catch(reject);
        }
      }
    });
    if (options.signal.aborted) abort();
  });
};

const createRunner = (cancellation: AbortController, options: AcceptanceOptions = {}) => {
  const scope = options.scope === undefined ? 'all' : readAcceptanceScope(options.scope);
  if (scope === 'container' && options.allowApfsImage === true) throw new Error('Container acceptance cannot use native APFS storage.');
  const expectedServerShutdowns = new WeakSet<ChildProcess>();
  const run = (file: string, args: readonly string[], options: Omit<CommandOptions, 'cwd'> & { cwd?: string } = {}): Promise<string> =>
    command(file, args, { cwd: repositoryRoot, signal: cancellation.signal, ...options });

  const readyInstallation = (installed: InstalledEvidence | undefined): ReadyInstalledEvidence => {
    if (installed?.receiptPath === undefined || installed.receipt === undefined) throw new Error('The shared installed CLI is not prepared.');
    return { ...installed, receiptPath: installed.receiptPath, receipt: installed.receipt };
  };

  const sourceIdentity = async (): Promise<Source> => {
    const gitSha = await run('git', ['rev-parse', 'HEAD'], { quiet: true });
    const gitTreeSha = await run('git', ['rev-parse', 'HEAD^{tree}'], { quiet: true });
    const dirty = (await run('git', ['status', '--porcelain', '--untracked-files=normal'], { quiet: true })) !== '';
    const githubSha = process.env.GITHUB_SHA ?? null;
    if (!/^[a-f0-9]{40}$/.test(gitSha) || !/^[a-f0-9]{40}$/.test(gitTreeSha)) throw new Error('Invalid source revision or tree.');
    if (process.env.CI && (dirty || githubSha !== gitSha)) throw new Error('CI acceptance requires a clean checkout at GITHUB_SHA.');
    return { gitSha, gitTreeSha, githubSha, dirty };
  };

  const playwright = async (target: BrowserPhase, directory: string, installed: ReadyInstalledEvidence): Promise<BrowserPhase> => {
    let identitySaved: Promise<void> = Promise.resolve();
    let failure: unknown;
    try {
      if (typeof target.caseSensitiveStorage !== 'boolean'
        || (!target.caseSensitiveStorage && (target.target !== 'native' || process.platform !== 'darwin'))) {
        throw new Error('Browser phase has invalid filesystem case-sensitivity coverage.');
      }
      target.browserInventory = await browserInventory();
      target.browserCleanup = 'pending';
      await json(join(directory, 'target.json'), target);
      await mkdir(join(packageRoot, '.tmp'), { recursive: true });
      await run('pnpm', ['exec', 'playwright', 'test', '--workers=1', '--retries=0', '--reporter=line,json',
        target.phase === 'capacity' ? '--grep' : '--grep-invert', '@capacity'], {
        cwd: packageRoot, timeoutMs: 900_000,
        env: { ...process.env, TMPDIR: '.tmp', DAYNIGHT_BASE_URL: target.baseUrl, DAYNIGHT_ACCEPTANCE_TARGET: target.target,
          DAYNIGHT_ACCEPTANCE_DIRECTORY: directory, DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT: installed.receiptPath, PLAYWRIGHT_JSON_OUTPUT_FILE: join(directory, 'playwright.json') },
        onSpawn: (child) => {
          target.playwrightGroup = child.pid!;
          identitySaved = (async () => {
            const identity = await processIdentity(child.pid!);
            if (identity !== null) target.playwrightProcess = identity;
            await json(join(directory, 'target.json'), target);
          })();
          void identitySaved.catch(() => {});
        },
      });
      await identitySaved;
      target.scenarios = readReport(await readJson(join(directory, 'playwright.json')),
        target.phase === 'capacity' ? capacityScenarios : functionalScenarios);
      for (const scenario of target.scenarios) {
        for (const path of scenario.screenshots) {
          if (!resolve(path).startsWith(`${resolve(directory)}${sep}`)) throw new Error('Screenshot lies outside the owned acceptance directory.');
          const screenshot = await readFile(path);
          if (!screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid screenshot evidence.');
        }
      }
      const browser = await readJson(join(directory, 'browser.json')) as Record<string, unknown>;
      if (browser.name !== 'chromium' || typeof browser.version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(browser.version)
        || browser.platform !== process.platform || !['linux', 'darwin'].includes(String(browser.platform))
        || (process.env.CI && browser.executableOverride !== false)) {
        throw new Error('Invalid browser identity for production acceptance.');
      }
      if (process.env.CI) {
        const testRequire = createRequire(import.meta.resolve('@playwright/test'));
        const playwrightRequire = createRequire(testRequire.resolve('playwright'));
        const corePackage = playwrightRequire.resolve('playwright-core/package.json');
        const registry = await readJson(join(dirname(corePackage), 'browsers.json')) as { browsers: { name: string; browserVersion?: string }[] };
        const bundled = registry.browsers.find((candidate) => candidate.name === 'chromium');
        if (bundled === undefined || bundled.browserVersion !== browser.version) throw new Error('CI must use the pinned Playwright Chromium version.');
      }
      target.browser = browser;
    } catch (error) { failure = error; }
    finally {
      const failures: unknown[] = failure === undefined ? [] : [failure];
      try { await identitySaved; } catch (error) { if (!failures.includes(error)) failures.push(error); }
      if (target.playwrightGroup !== undefined) {
        try { requireGroupStopped(target.playwrightGroup); } catch (error) { failures.push(error); }
      }
      try { await recoverCliProcesses(dirname(installed.receipt.root), installed.receiptPath, installed.receipt); }
      catch (error) { failures.push(error); }
      if (target.browserInventory !== undefined) {
        try { await recoverBrowsers(directory, target.browserInventory); target.browserCleanup = 'passed'; }
        catch (error) { target.browserCleanup = 'failed'; failures.push(error); }
      }
      target.finishedAt = new Date().toISOString();
      target.result = failures.length === 0 ? 'passed' : 'failed';
      if (failures.length > 0) target.error = failures.map((error) => error instanceof Error ? error.message : String(error)).join('; ');
      try { await json(join(directory, 'target.json'), target); } catch (error) { failures.push(error); }
      if (failures.length > 0) throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Browser phase or cleanup failed.');
    }
    return target;
  };

  const containerCallback = async (): Promise<void> => {
    const directory = process.env.DAYNIGHT_ACCEPTANCE_DIRECTORY;
    const runId = process.env.DAYNIGHT_DEV_CI_RUN_ID;
    const baseUrl = process.env.DAYNIGHT_BASE_URL;
    if (directory === undefined || !directory.startsWith(`${evidenceRoot}/`) || runId === undefined
      || !/^\d{14}-\d+-\d{5}$/.test(runId) || baseUrl === undefined || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) {
      throw new Error('Invalid owned container acceptance invocation.');
    }
    const acceptanceDirectory = dirname(directory);
    const evidence = await readJson(join(acceptanceDirectory, 'evidence.json')) as Evidence;
    const header = readEvidenceHeader(evidence, 'container');
    if (directory !== join(evidenceRoot, header.runId, 'container')) throw new Error('Container callback does not belong to this acceptance source and run.');
    validateEvidenceScope(evidence);
    const project = `daynight-dev-ci-${runId}`;
    const callback = await processIdentity(process.pid);
    if (callback === null) throw new Error('Container callback process identity disappeared.');
    await json(join(directory, 'callback.json'), callback);
    await json(join(directory, 'dev-ci-run.json'), { runId });
    const postgresContainer = await run('docker', ['ps', '--quiet', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`,
      '--filter', 'label=com.docker.compose.service=postgres'], { quiet: true, timeoutMs: 10_000 });
    if (!/^[a-f0-9]{64}$/.test(postgresContainer)) throw new Error('Dev-ci PostgreSQL container was not uniquely identified.');
    await json(join(directory, 'ready.json'), { acceptanceRunId: evidence.runId, devCiRunId: runId,
      sourceGitSha: evidence.source.gitSha, callback, readyAt: new Date().toISOString() });
    if (evidence.scope === 'all') {
      await waitForContainerPermission(directory, { acceptanceRunId: evidence.runId, devCiRunId: runId,
        sourceGitSha: evidence.source.gitSha }, { signal: cancellation.signal, timeoutMs: 900_000 });
    }
    cancellation.signal.throwIfAborted();
    const prepared = await readJson(join(acceptanceDirectory, 'evidence.json')) as Evidence;
    const preparedHeader = readEvidenceHeader(prepared, 'container');
    if (preparedHeader.scope !== header.scope || preparedHeader.runId !== header.runId
      || preparedHeader.source.gitSha !== header.source.gitSha || preparedHeader.source.gitTreeSha !== header.source.gitTreeSha) {
      throw new Error('Container parent identity changed during preparation.');
    }
    validateEvidenceScope(prepared);
    const installation = readyInstallation(prepared.installedCli);
    await validateInstalledCli(installation.receiptPath, acceptanceDirectory);
    const phase = await playwright({ target: 'container', phase: 'functional', result: 'running', startedAt: new Date().toISOString(),
      browserCleanup: 'not-started', caseSensitiveStorage: true, baseUrl, postgresContainer,
      projectLabel: { key: 'com.docker.compose.project', value: project }, database: 'daynight' }, directory, installation);
    const serverId = await run('docker', ['ps', '--quiet', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`,
      '--filter', 'label=com.docker.compose.service=server'], { quiet: true, timeoutMs: 10_000 });
    const manifest = await readJson(join(repositoryRoot, '.tmp/dev-ci', runId, 'manifest.json')) as { imageId: string };
    const target: CombinedTarget = { target: 'container', baseUrl, sourceGitSha: evidence.source.gitSha, acceptanceDirectory,
      postgresContainer, projectLabel: { key: 'com.docker.compose.project', value: project }, database: 'daynight',
      storage: { kind: 'container', root: '/var/lib/daynight/storage', containerId: serverId, imageId: manifest.imageId } };
    const combinedDirectory = join(directory, 'auth-combined');
    const combined = await runAuthCombined({ target, directory: combinedDirectory, installedReceiptPath: installation.receiptPath, signal: cancellation.signal,
      restartTarget: async (ownedRun, restartSignal) => restartContainerServer({ containerId: serverId, imageId: manifest.imageId, project, origin: baseUrl,
        signal: restartSignal, run: ownedRun, record: async (value) => json(join(combinedDirectory, 'restart.json'), value) }),
      readLogs: async (ownedRun) => {
        const logs = await ownedRun('bash', ['-c', 'docker logs "$1" 2>&1', 'auth-combined-logs', serverId], { quiet: true, timeoutMs: 10_000 });
        const privateState = await readJson(join(repositoryRoot, '.tmp/dev-ci-private', runId, 'auth-state.json')) as { publicOrigin: string; appSecret: string };
        if (privateState.publicOrigin !== baseUrl || typeof privateState.appSecret !== 'string' || privateState.appSecret === '' || logs.includes(privateState.appSecret)) throw new Error('Container private authentication log scan failed.');
        return logs;
      } });
    sameBrowser(combined, phase.browser);
  };

  const wait = async (milliseconds: number): Promise<void> => {
    cancellation.signal.throwIfAborted();
    await new Promise<void>((resolveWait, reject) => {
      const timer = setTimeout(() => { cancellation.signal.removeEventListener('abort', abort); resolveWait(); }, milliseconds);
      const abort = (): void => { clearTimeout(timer); reject(new Error('Acceptance cancelled.')); };
      cancellation.signal.addEventListener('abort', abort, { once: true });
    });
  };

  let nativeLogSink: ((data: Buffer) => void) | undefined;
  const trackNativeChild = async (nativeChild: ChildProcess, binary: string, evidence: NativeEvidence,
    register: (child: ChildProcess) => void, persist: () => Promise<void>): Promise<void> => {
    register(nativeChild); evidence.processPid = nativeChild.pid!; delete evidence.processIdentity;
    nativeChild.stderr!.on('data', (data: Buffer) => nativeLogSink?.(data));
    await persist();
    const identity = await processIdentity(nativeChild.pid!);
    if (identity !== null) {
      if (identity.executable !== binary) throw new Error('Native Go executable identity differs from the owned binary.');
      evidence.processIdentity = identity; (evidence.processHistory ??= []).push(identity);
    }
    await persist();
  };
  const startServer = async (binary: string, databaseUrl: string, evidence: NativeEvidence, register: (child: ChildProcess) => void,
    persist: () => Promise<void>, fixtureBinary: string, fixtureBinarySha256: string): Promise<{ child: ChildProcess; baseUrl: string; fixture: AuthFixture }> => {
    cancellation.signal.throwIfAborted();
    evidence.storage = await prepareStorage(evidence.storageRoot, { allowApfsImage: options.allowApfsImage === true, persist: async (receipt) => {
      evidence.storage = receipt;
      await persist();
    } });
    for (let attempt = 0; attempt < 3; attempt++) {
      cancellation.signal.throwIfAborted();
      const baseUrl = `http://127.0.0.1:${await reserveLoopbackPort()}`;
      const owned: AuthFixtureEvidence = { directory: join(privateRoot, basename(dirname(evidence.binary)), 'auth', `native-auth-${attempt}`),
        binary: fixtureBinary, binarySha256: fixtureBinarySha256, cleanup: 'pending' };
      evidence.authFixtures ??= [];
      evidence.authFixtures.push(owned);
      await persist();
      let fixture: AuthFixture | undefined;
      try {
        fixture = await startAuthFixture({ binary: fixtureBinary, directory: owned.directory,
          callbackURL: `${baseUrl}/api/v1/auth/callback`, signal: cancellation.signal,
          onSpawn: async (fixtureChild) => {
            owned.processPid = fixtureChild.pid!;
            await persist();
            const identity = await processIdentity(fixtureChild.pid!);
            if (identity !== null) {
              if (identity.executable !== fixtureBinary) throw new Error('UniAuth fixture identity differs from the prepared binary.');
              owned.processIdentity = identity;
            }
            await persist();
          },
        });
        const child = await launchNativeServer({ binary, databaseUrl, storageRoot: evidence.storage.root, baseUrl, auth: fixture,
          signal: cancellation.signal,
          onSpawn: async (nativeChild) => trackNativeChild(nativeChild, binary, evidence, register, persist),
          onUnexpectedExit: (nativeChild, code, signal) => {
            if (!expectedServerShutdowns.has(nativeChild)) cancellation.abort(new Error(`Native Go exited unexpectedly (exit=${code}, signal=${signal}).`));
          },
        });
        return { child, baseUrl, fixture };
      } catch (error) {
        const cleanupFailures: unknown[] = [];
        try { await fixture?.close(); } catch (cleanup) { cleanupFailures.push(cleanup); }
        try { await cleanupAuthFixture(owned, dirname(evidence.binary)); owned.cleanup = 'passed'; }
        catch (cleanup) { owned.cleanup = 'failed'; cleanupFailures.push(cleanup); }
        try { await persist(); } catch (cleanup) { cleanupFailures.push(cleanup); }
        if (cleanupFailures.length > 0) throw new AggregateError([error, ...cleanupFailures], 'Native startup and UniAuth fixture cleanup failed.');
        if (!(error instanceof NativeAddressInUseError) || attempt === 2) throw error;
      }
    }
    throw new Error('Native Go exhausted proven loopback port conflicts.');
  };

  const stopServer = async (child: ChildProcess | undefined): Promise<void> => {
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Native Go exited before the requested shutdown.');
    expectedServerShutdowns.add(child);
    const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    child.kill('SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>((resolveWait) => { timer = setTimeout(() => resolveWait(false), 20_000); })]);
    clearTimeout(timer);
    if (!graceful) {
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Owned native Go process did not exit.')), 5_000); })]);
      clearTimeout(timer);
      throw new Error('Native Go required forced shutdown.');
    }
    if (child.exitCode !== 0) throw new Error('Native Go did not shut down successfully.');
  };

  const cleanupNative = async (native: NativeEvidence): Promise<void> => {
    const options = { cwd: repositoryRoot, quiet: true, timeoutMs: 20_000 };
    const containers = await command('docker', ['ps', '--all', '--quiet', '--filter', `label=${labelKey}=${native.owner}`], options);
    for (const id of containers.split('\n').filter(Boolean)) {
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Invalid owned container identity.');
      const identity = await command('docker', ['inspect', '--format', `{{.Name}}|{{index .Config.Labels "${labelKey}"}}`, id], options);
      if (identity !== `/${native.postgresContainer}|${native.owner}`) throw new Error('Native container ownership differs from its receipt.');
      await command('docker', ['rm', '--force', '--volumes', id], options);
    }
    const volumes = await command('docker', ['volume', 'ls', '--quiet', '--filter', `label=${labelKey}=${native.owner}`], options);
    for (const name of volumes.split('\n').filter(Boolean)) {
      if (name !== native.postgresVolume) throw new Error('Unexpected volume with native ownership label.');
      const owner = await command('docker', ['volume', 'inspect', '--format', `{{index .Labels "${labelKey}"}}`, name], options);
      if (owner !== native.owner) throw new Error('Native volume ownership differs from its receipt.');
      await command('docker', ['volume', 'rm', name], options);
    }
    const remaining = await command('docker', ['ps', '--all', '--quiet', '--filter', `label=${labelKey}=${native.owner}`], options);
    const remainingVolumes = await command('docker', ['volume', 'ls', '--quiet', '--filter', `label=${labelKey}=${native.owner}`], options);
    if (remaining !== '' || remainingVolumes !== '') throw new Error('Native acceptance resources remain.');
  };

  const cleanupNativeStorage = async (native: NativeEvidence, runId: string): Promise<void> => {
    const storageRoot = join(evidenceRoot, runId, 'native-storage');
    if (!/^\d{14}-[a-f0-9-]{36}$/.test(runId) || native.storageRoot !== storageRoot
      || native.binary !== join(evidenceRoot, runId, 'daynight-server')) {
      throw new Error('Native storage ownership differs from its receipt.');
    }
    if (native.processIdentity !== undefined) await requireStopped(native.processIdentity);
    else if (native.processPid !== undefined && await processIdentity(native.processPid) !== null) {
      throw new Error('Native process lacks enough identity evidence for storage cleanup.');
    }
    const stored = native.storage ?? await optionalJson(join(storageRoot, 'storage-receipt.json')) as StorageReceipt | undefined;
    if (stored !== undefined) {
      if (stored.directory !== storageRoot) throw new Error('Native storage receipt belongs to a different directory.');
      await cleanupStorage(stored);
    } else {
      // A directory without its write-ahead receipt cannot be safely attributed to this run.
      try { await lstat(storageRoot); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
      throw new Error('Native storage is missing its ownership receipt.');
    }
  };

  const validateAuthFixtureOwnership = (fixture: AuthFixtureEvidence, directory: string): void => {
    if (!/^native-auth-[0-2]$/.test(fixture.directory.split('/').at(-1)!)
      || dirname(fixture.directory) !== join(privateRoot, basename(directory), 'auth') || dirname(directory) !== evidenceRoot
      || !/^\d{14}-[a-f0-9-]{36}$/.test(directory.split('/').at(-1)!)
      || fixture.binary !== join(serverRoot, '.tmp/uniauth-fixture') || !/^[a-f0-9]{64}$/.test(fixture.binarySha256)) {
      throw new Error('UniAuth fixture ownership differs from the prepared binary.');
    }
  };

  const cleanupAuthFixture = async (fixture: AuthFixtureEvidence, directory: string): Promise<void> => {
    validateAuthFixtureOwnership(fixture, directory);
    if (fixture.processIdentity !== undefined) await requireStopped(validIdentity(fixture.processIdentity));
    else if (fixture.processPid !== undefined && await processIdentity(fixture.processPid) !== null) throw new Error('UniAuth fixture lacks enough identity evidence for cleanup.');
    await rm(fixture.directory, { recursive: true, force: true });
    for (const path of [dirname(fixture.directory), dirname(dirname(fixture.directory))]) {
      try { await rmdir(path); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOTEMPTY') break;
        if (code !== 'ENOENT') throw error;
      }
    }
  };

  const validIdentity = (value: unknown): ProcessIdentity => {
    if (value === null || typeof value !== 'object') throw new Error('Missing recorded process identity.');
    const identity = value as ProcessIdentity;
    if (identity.platform !== process.platform || !['linux', 'darwin'].includes(identity.platform) || !Number.isSafeInteger(identity.pid) || identity.pid <= 1 || typeof identity.executable !== 'string'
      || !identity.executable.startsWith('/') || typeof identity.startTicks !== 'string' || !/^\d+$/.test(identity.startTicks)
      || !Number.isSafeInteger(identity.group) || identity.group <= 0) {
      throw new Error('Invalid recorded process identity.');
    }
    return identity;
  };

  const recoverProcess = async (owned: { processPid?: number; processIdentity?: ProcessIdentity; binary: string; binarySha256?: string }): Promise<{ result: string; forced?: boolean }> => {
    if (owned.processIdentity === undefined) {
      if (owned.processPid !== undefined && await processIdentity(owned.processPid) !== null) throw new Error('Owned process lacks enough identity evidence for recovery.');
      return { result: 'not-started' };
    }
    const identity = validIdentity(owned.processIdentity);
    if (identity.pid !== owned.processPid || identity.executable !== owned.binary) throw new Error('Owned process receipt does not match its binary.');
    const observed = await processIdentity(identity.pid);
    if (observed !== null && observed.startTicks === identity.startTicks && !sameProcess(identity, observed)) throw new Error('Owned executable identity changed before recovery.');
    if (!sameProcess(identity, observed)) return { result: 'absent' };
    if (owned.binarySha256 === undefined || !/^[a-f0-9]{64}$/.test(owned.binarySha256)
      || createHash('sha256').update(await readFile(owned.binary)).digest('hex') !== owned.binarySha256) {
      throw new Error('Owned recovery executable hash differs from the built artifact.');
    }
    if (!sameProcess(identity, await processIdentity(identity.pid))) throw new Error('Owned process changed during recovery verification.');
    process.kill(identity.pid, 'SIGTERM');
    let deadline = Date.now() + 20_000;
    while (sameProcess(identity, await processIdentity(identity.pid)) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
    let forced = false;
    if (sameProcess(identity, await processIdentity(identity.pid))) {
      process.kill(identity.pid, 'SIGKILL');
      forced = true;
      deadline = Date.now() + 5_000;
      while (sameProcess(identity, await processIdentity(identity.pid)) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
    }
    if (sameProcess(identity, await processIdentity(identity.pid))) throw new Error('Verified owned process remains after bounded recovery.');
    return forced ? { result: 'stopped', forced } : { result: 'stopped' };
  };

  const optionalJson = async (path: string): Promise<unknown | undefined> => {
    try { return await readJson(path); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  };

  const recoverBrowserDirectory = async (directory: string, sourceGitSha: string): Promise<void> => {
    const target = await optionalJson(join(directory, 'target.json')) as (BrowserPhase & Partial<AuthCombinedReceipt>) | undefined;
    if (target?.kind === 'auth-combined') {
      if (target.schemaVersion !== 1 || target.sourceGitSha !== sourceGitSha || !Array.isArray(target.commands) || !Array.isArray(target.commandGroups)) throw new Error('Combined recovery ownership differs from its source.');
      for (const identity of target.commands) await requireStopped(validIdentity(identity));
      for (const group of target.commandGroups) {
        if (!Number.isSafeInteger(group) || group <= 1) throw new Error('Invalid combined command group.');
        requireGroupStopped(group);
      }
    }
    if (target?.playwrightProcess !== undefined) { const identity = validIdentity(target.playwrightProcess); await requireStopped(identity); requireGroupStopped(identity.pid); }
    if (target?.playwrightGroup !== undefined) requireGroupStopped(target.playwrightGroup);
    if (target?.browserInventory !== undefined) await recoverBrowsers(directory, target.browserInventory);
  };

  const cleanupInstallation = async (evidence: Evidence, directory: string, persist: () => Promise<void>): Promise<void> => {
    const installed = evidence.installedCli;
    if (installed === undefined) return;
    if (installed.root !== join(directory, 'installed-cli')
      || (installed.receiptPath === undefined) !== (installed.receipt === undefined)) throw new Error('Installed CLI preparation ownership differs from this run.');
    for (const stage of evidence.stages) {
      for (const identity of stage.commands) await requireStopped(validIdentity(identity));
      for (const group of stage.commandGroups) requireGroupStopped(group);
    }
    if (installed.receipt !== undefined && installed.receiptPath !== undefined) {
      if (installed.receipt.root !== installed.root || installed.receipt.source.gitSha !== evidence.source.gitSha
        || installed.receipt.source.gitTreeSha !== evidence.source.gitTreeSha
        || installed.receipt.source.dirty !== evidence.source.dirty) throw new Error('Installed CLI artifact source differs from its owner.');
      const present = await optionalJson(installed.receiptPath);
      if (present !== undefined) await validateInstalledCli(installed.receiptPath, directory);
      else if (installed.cleanup !== 'passed') throw new Error('Installed CLI artifacts disappeared before confirmed cleanup.');
      await recoverCliProcesses(directory, installed.receiptPath, installed.receipt);
    }
    await rm(installed.root, { recursive: true, force: true });
    installed.cleanup = 'passed';
    await persist();
  };

  const recover = async (requestedRunId: string | undefined): Promise<void> => {
    if (requestedRunId !== undefined && !/^\d{14}-[a-f0-9-]{36}$/.test(requestedRunId)) throw new Error('Invalid acceptance recovery run ID.');
    const original = await optionalJson(requestedRunId === undefined ? join(evidenceRoot, 'evidence.json') : join(evidenceRoot, requestedRunId, 'evidence.json'));
    if (original === undefined) { console.log('Web acceptance recovery: no run receipt; no resources were changed.'); return; }
    const evidence = original as Evidence;
    if (evidence.schemaVersion !== acceptanceEvidenceSchemaVersion || !['all', 'native', 'container'].includes(evidence.scope) || !/^\d{14}-[a-f0-9-]{36}$/.test(evidence.runId)
      || (requestedRunId !== undefined && evidence.runId !== requestedRunId)) throw new Error('Invalid acceptance recovery receipt.');
    validateEvidenceScope(evidence);
    const directory = join(evidenceRoot, evidence.runId);
    const owner = `daynight-web-${evidence.runId}`;
    if (!/^[a-f0-9]{40}$/.test(evidence.source.gitSha) || !/^[a-f0-9]{40}$/.test(evidence.source.gitTreeSha)
      || (process.env.GITHUB_SHA !== undefined && evidence.source.githubSha !== process.env.GITHUB_SHA)
      || (evidence.scope === 'container' && 'native' in evidence)
      || (evidence.scope === 'native' && (evidence.devCi !== undefined || evidence.container !== undefined))) {
      throw new Error('Recovery receipt does not identify this run resources and source.');
    }
    if (evidence.scope !== 'container') {
      const native = nativeEvidence(evidence);
      if (native === undefined || native.owner !== owner || native.postgresContainer !== `${owner}-postgres` || native.postgresVolume !== `${owner}-data`
        || native.binary !== join(directory, 'daynight-server') || native.storageRoot !== join(directory, 'native-storage')) {
        throw new Error('Recovery receipt does not identify this run resources and source.');
      }
    }
    const receipt: Record<string, unknown> = { schemaVersion: acceptanceEvidenceSchemaVersion, scope: evidence.scope, runId: evidence.runId, result: 'running', startedAt: new Date().toISOString() };
    const save = async (): Promise<void> => {
      await json(join(directory, 'recovery.json'), receipt);
      await json(join(evidenceRoot, 'recovery.json'), receipt);
    };
    await save();
    try {
      await requireStopped(validIdentity(evidence.runner));
      if (!Array.isArray(evidence.stages)) throw new Error('Recovery receipt is missing its pipeline stages.');
      for (const stage of evidence.stages) {
        if (!Array.isArray(stage.commands) || !Array.isArray(stage.commandGroups)) throw new Error('Invalid pipeline command ownership.');
        for (const identity of stage.commands) await requireStopped(validIdentity(identity));
        for (const group of stage.commandGroups) {
          if (!Number.isSafeInteger(group) || group <= 1) throw new Error('Invalid pipeline command group.');
          requireGroupStopped(group);
        }
      }
      if (evidence.scope !== 'native') {
        if (evidence.devCi?.runner !== undefined) {
          const identity = validIdentity(evidence.devCi.runner);
          await requireStopped(identity); requireGroupStopped(identity.pid);
        }
        const callback = await optionalJson(join(directory, 'container/callback.json'));
        if (callback !== undefined) {
          const identity = validIdentity(callback);
          await requireStopped(identity); requireGroupStopped(identity.pid);
        }
      }
      for (const targetName of browserDirectories(evidence.scope)) await recoverBrowserDirectory(join(directory, targetName), evidence.source.gitSha);
      if (evidence.installedCli !== undefined) {
        await cleanupInstallation(evidence, directory, async () => {
          await json(join(directory, 'evidence.json'), evidence);
          const latest = await optionalJson(join(evidenceRoot, 'evidence.json')) as Evidence | undefined;
          if (latest?.runId === evidence.runId) await json(join(evidenceRoot, 'evidence.json'), evidence);
        });
        receipt.installedCli = 'passed';
      }
      if (evidence.scope !== 'container') {
        const native = nativeEvidence(evidence);
        const nativeProcess = await recoverProcess(native);
        receipt.nativeProcess = nativeProcess.result;
        if (nativeProcess.forced) receipt.nativeForced = true;
        if (native.authFixtures !== undefined) {
          if (!Array.isArray(native.authFixtures) || native.authFixtures.length > 3) throw new Error('Invalid native UniAuth fixture ownership.');
          receipt.authFixtures = [];
          for (const fixture of native.authFixtures) {
            validateAuthFixtureOwnership(fixture, directory);
            const process = await recoverProcess(fixture);
            await cleanupAuthFixture(fixture, directory);
            fixture.cleanup = 'passed';
            (receipt.authFixtures as unknown[]).push({ directory: fixture.directory, ...process });
          }
          await json(join(directory, 'evidence.json'), evidence);
          const latest = await optionalJson(join(evidenceRoot, 'evidence.json')) as Evidence | undefined;
          if (latest?.runId === evidence.runId) await json(join(evidenceRoot, 'evidence.json'), evidence);
        }
        await cleanupNative(native);
        receipt.nativeDocker = 'passed';
        await cleanupNativeStorage(native, evidence.runId);
        receipt.nativeStorage = 'passed';
      }
      if (evidence.devCi?.runId !== undefined) {
        const runId = evidence.devCi.runId;
        if (!/^\d{14}-\d+-\d{5}$/.test(runId)) throw new Error('Invalid recorded dev-ci recovery run ID.');
        const manifest = await readJson(join(repositoryRoot, '.tmp/dev-ci', runId, 'manifest.json')) as Record<string, unknown>;
        if (manifest.runId !== runId || manifest.project !== `daynight-dev-ci-${runId}`) throw new Error('Dev-ci recovery receipt ownership differs.');
        await command('bash', ['deployment/dev-ci/run.sh', '--cleanup', runId], { cwd: repositoryRoot, timeoutMs: 180_000 });
        const recovered = await readJson(join(repositoryRoot, '.tmp/dev-ci', runId, 'recovery-manifest.json')) as Record<string, unknown>;
        if (recovered.cleanupResult !== 'passed') throw new Error('Dev-ci targeted recovery did not pass.');
        receipt.devCi = recovered;
      }
      receipt.result = 'passed';
    } catch (error) {
      receipt.result = 'failed'; receipt.error = error instanceof Error ? error.message : 'Owned-resource recovery failed.';
      throw error;
    } finally { receipt.finishedAt = new Date().toISOString(); await save(); }
    console.log(`Web acceptance recovery ${evidence.runId}: passed.`);
  };

  const main = async (): Promise<void> => {
    const compose = await readFile(join(repositoryRoot, 'deployment/dev-ci/compose.yaml'), 'utf8');
    const images = [...compose.matchAll(/^\s+image:\s+(postgres:18\.6-bookworm@sha256:[a-f0-9]{64})\s*$/gm)];
    if (images.length !== 1) throw new Error('Dev-ci must declare exactly one pinned PostgreSQL 18.6 image.');
    const postgresImage = images[0]![1]!;
    const runId = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID()}`;
    const directory = join(evidenceRoot, runId);
    const containerDirectory = join(directory, 'container');
    const owner = `daynight-web-${runId}`;
    const runner = await processIdentity(process.pid);
    if (runner === null) throw new Error('Acceptance runner process identity disappeared.');
    const initial = { schemaVersion: acceptanceEvidenceSchemaVersion, runId, source: await sourceIdentity(), startedAt: new Date().toISOString(),
      result: 'running' as const, targets: [], stages: [], cleanup: 'pending' as const, runner, authCombined: [] };
    const evidence: Evidence = scope === 'container' ? { ...initial, scope } : { ...initial, scope,
      native: { owner, postgresContainer: `${owner}-postgres`, postgresVolume: `${owner}-data`,
        binary: join(directory, 'daynight-server'), storageRoot: join(directory, 'native-storage'), postgresImage, cleanup: 'pending' } };
    let evidenceWrites = Promise.resolve();
    const save = (): Promise<void> => {
      evidenceWrites = evidenceWrites.then(async () => {
        await json(join(directory, 'evidence.json'), evidence);
        await json(join(evidenceRoot, 'evidence.json'), evidence);
      });
      return evidenceWrites;
    };
    const stage = async (name: string, operation: (ownedRun: AcceptanceCommand, register: (child: ChildProcess) => Promise<void>) => Promise<void>): Promise<void> => {
      const current: Stage = { name, result: 'running', startedAt: new Date().toISOString(), commands: [], commandGroups: [] };
      evidence.stages.push(current);
      await save();
      const register = async (child: ChildProcess): Promise<void> => {
        current.commandGroups.push(child.pid!);
        const identity = await processIdentity(child.pid!);
        if (identity !== null) current.commands.push(identity);
        await save();
      };
      const ownedRun: AcceptanceCommand = async (file, args, options = {}) => {
        let identitySaved = Promise.resolve();
        let failure: unknown;
        let group: number | undefined;
        let output = '';
        try {
          output = await run(file, args, { ...options, onSpawn: (child) => {
            group = child.pid!;
            identitySaved = Promise.all([register(child), options.onSpawn?.(child)]).then(() => {});
            return identitySaved;
          } });
        } catch (error) { failure = error; }
        try { await identitySaved; }
        catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Command and identity recording failed.'); }
        if (group !== undefined) {
          try { requireGroupStopped(group); }
          catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Command and process group cleanup failed.'); }
        }
        if (failure !== undefined) throw failure;
        return output;
      };
      let failure: unknown;
      try { await operation(ownedRun, register); }
      catch (error) { failure = error; current.error = error instanceof Error ? error.message : String(error); }
      current.result = failure === undefined ? 'passed' : 'failed';
      current.finishedAt = new Date().toISOString();
      try { await save(); }
      catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Stage and evidence recording failed.'); }
      if (failure !== undefined) throw failure;
    };
    const installedEvidence = (): ReadyInstalledEvidence => readyInstallation(evidence.installedCli);
    const prepareInstallation = async (ownedRun: AcceptanceCommand, register: (child: ChildProcess) => Promise<void>): Promise<void> => {
      if (options.packedPackage === undefined) await ownedRun('pnpm', ['build'], { timeoutMs: 180_000 });
      evidence.installedCli = { root: join(directory, 'installed-cli'), cleanup: 'pending' };
      await save();
      const installed = await prepareInstalledCli({ signal: cancellation.signal, temporaryRoot: directory,
        rootDirectory: evidence.installedCli.root, onSpawn: register,
        ...(options.packedPackage === undefined ? {} : { packedPackage: options.packedPackage }) });
      evidence.installedCli.receiptPath = installed.receiptPath;
      evidence.installedCli.receipt = installed.receipt;
      await save();
      await validateInstalledCli(installed.receiptPath, directory);
    };
    let child: ChildProcess | undefined;
    let authFixture: AuthFixture | undefined;
    let nativeDatabaseUrl: string | undefined;
    let nativeTarget: Target | undefined;
    let devCiRunId: string | undefined;
    let failure: unknown;
    const native = (): Target => {
      if (nativeTarget === undefined) throw new Error('Native target is not prepared.');
      return nativeTarget;
    };
    const nativePhase = (phase: 'functional' | 'capacity'): BrowserPhase => {
      const target = native();
      const caseSensitiveStorage = nativeEvidence(evidence).storage?.caseSensitive;
      if (typeof caseSensitiveStorage !== 'boolean') throw new Error('Native storage capability was not recorded.');
      const result: BrowserPhase = { target: 'native', baseUrl: target.baseUrl, postgresContainer: target.postgresContainer,
        projectLabel: target.projectLabel, database: target.database, phase, caseSensitiveStorage, result: 'running',
        startedAt: new Date().toISOString(), browserCleanup: 'not-started' };
      target.phases.push(result);
      return result;
    };
    const aggregate = (target: Target, required: readonly string[]): void => {
      target.scenarios = aggregateScenarios(target.phases.map((phase) => {
        if (phase.result !== 'passed' || phase.browserCleanup !== 'passed' || phase.scenarios === undefined) {
          throw new Error('Target contains an incomplete browser phase.');
        }
        return phase.scenarios;
      }), required);
      const browsers = [...evidence.targets.filter((other) => other !== target).flatMap((other) => other.phases), ...target.phases]
        .map((phase) => phase.browser as Record<string, unknown>);
      const identity = (browser: Record<string, unknown>) => JSON.stringify([
        browser.name, browser.version, browser.platform, browser.executableOverride,
      ]);
      if (browsers.some((browser) => identity(browser) !== identity(browsers[0]!))) throw new Error('Browser identity changed between acceptance targets or phases.');
      target.result = 'passed';
    };
    await save();
    try {
      const phases = {
        nativePreparation: () => stage('native-preparation', async (ownedRun, register) => {
          const nativeRecord = nativeEvidence(evidence);
          console.log(`Web acceptance ${runId}: building production assets and native Go executable.`);
          await prepareInstallation(ownedRun, register);
          await ownedRun('pnpm', ['web:build'], { timeoutMs: 180_000 });
          await ownedRun('bash', ['-c', 'source scripts/env.sh\ngo build -o "$1" ./cmd/daynight-server', 'acceptance-build', nativeRecord.binary],
            { cwd: serverRoot, timeoutMs: 300_000 });
          nativeRecord.binarySha256 = createHash('sha256').update(await readFile(nativeRecord.binary)).digest('hex');
          await save();
          const fixtureBinary = await ownedRun(process.execPath, ['scripts/prepare-uniauth-fixture.mts'], { cwd: serverRoot, quiet: true, timeoutMs: 600_000 });
          if (fixtureBinary !== join(serverRoot, '.tmp/uniauth-fixture')) throw new Error('Canonical UniAuth preparation returned an unexpected binary path.');
          const fixtureBinarySha256 = createHash('sha256').update(await readFile(fixtureBinary)).digest('hex');
          await ownedRun('docker', ['volume', 'create', '--label', `${labelKey}=${owner}`, nativeRecord.postgresVolume], { quiet: true });
          await ownedRun('docker', ['run', '--detach', '--name', nativeRecord.postgresContainer, '--label', `${labelKey}=${owner}`,
            '--publish', '127.0.0.1::5432', '--mount', `type=volume,src=${nativeRecord.postgresVolume},dst=/var/lib/postgresql`,
            '--env', 'POSTGRES_USER=daynight', '--env', 'POSTGRES_DB=daynight', '--env', 'POSTGRES_PASSWORD=daynight-browser-fixture', postgresImage],
          { timeoutMs: 180_000, quiet: true });
          const deadline = Date.now() + 60_000;
          while (true) {
            const status = await ownedRun('docker', ['inspect', '--format', '{{.State.Running}}', nativeRecord.postgresContainer], { quiet: true });
            if (status !== 'true') throw new Error('Owned PostgreSQL container stopped during startup.');
            try { await ownedRun('docker', ['exec', nativeRecord.postgresContainer, 'pg_isready', '-h', '127.0.0.1', '-U', 'daynight', '-d', 'daynight'], { quiet: true, timeoutMs: 5_000 }); break; }
            catch (error) { if (Date.now() >= deadline || cancellation.signal.aborted) throw error; await wait(250); }
          }
          nativeRecord.postgresVersion = await ownedRun('docker', ['exec', nativeRecord.postgresContainer, 'postgres', '--version'], { quiet: true });
          if (!/^postgres \(PostgreSQL\) 18\.6(?:\s|$)/.test(nativeRecord.postgresVersion)) throw new Error('Unexpected PostgreSQL version.');
          nativeRecord.postgresImageId = await ownedRun('docker', ['inspect', '--format', '{{.Image}}', nativeRecord.postgresContainer], { quiet: true });
          if (!/^sha256:[a-f0-9]{64}$/.test(nativeRecord.postgresImageId)) throw new Error('Invalid native PostgreSQL image identity.');
          const endpoint = await ownedRun('docker', ['port', nativeRecord.postgresContainer, '5432/tcp'], { quiet: true });
          if (!/^127\.0\.0\.1:[1-9]\d*$/.test(endpoint)) throw new Error('Native PostgreSQL lacks a unique loopback port.');
          nativeDatabaseUrl = `postgres://daynight:daynight-browser-fixture@${endpoint}/daynight?sslmode=disable`;
          const started = await startServer(nativeRecord.binary, nativeDatabaseUrl, nativeRecord,
            (ownedChild) => { child = ownedChild; }, save, fixtureBinary, fixtureBinarySha256);
          child = started.child;
          authFixture = started.fixture;
          nativeTarget = { target: 'native', result: 'running', baseUrl: started.baseUrl,
            postgresContainer: nativeRecord.postgresContainer, projectLabel: { key: labelKey, value: owner }, database: 'daynight', phases: [] };
          evidence.targets.push(nativeTarget);
          await save();
        }),
        nativeFunctional: () => stage('native-functional', async () => {
          const nativeRecord = nativeEvidence(evidence);
          const phase = nativePhase('functional');
          await save();
          await playwright(phase, join(directory, 'native/functional'), installedEvidence());
          await save();
          const target: CombinedTarget = { target: 'native', baseUrl: phase.baseUrl, sourceGitSha: evidence.source.gitSha, acceptanceDirectory: directory,
            postgresContainer: phase.postgresContainer, projectLabel: phase.projectLabel, database: 'daynight', storage: { kind: 'native', root: nativeRecord.storage!.root } };
          const combinedDirectory = join(directory, 'native/auth-combined');
          const logs: Buffer[] = []; let logBytes = 0; let logFailure = false;
          nativeLogSink = (data) => { logBytes += data.length; if (logBytes > 8 * 1024 * 1024) logFailure = true; else logs.push(data); };
          try {
            const combined = await runAuthCombined({ target, directory: combinedDirectory, installedReceiptPath: installedEvidence().receiptPath,
              signal: cancellation.signal,
              restartTarget: async (_ownedRun, restartSignal) => {
                if (child === undefined || authFixture === undefined || nativeDatabaseUrl === undefined || nativeRecord.processIdentity === undefined
                  || nativeRecord.binarySha256 === undefined) throw new Error('Native restart is missing its original owned configuration.');
                const beforeIdentity = nativeRecord.processIdentity;
                const before = { pid: beforeIdentity.pid, start: beforeIdentity.startTicks };
                const startedAt = new Date().toISOString();
                await json(join(combinedDirectory, 'restart.json'), { target: 'native', origin: phase.baseUrl, before, startedAt });
                await stopServer(child);
                await launchNativeServer({ binary: nativeRecord.binary, databaseUrl: nativeDatabaseUrl, storageRoot: nativeRecord.storage!.root,
                  baseUrl: phase.baseUrl, auth: authFixture, signal: restartSignal,
                  onSpawn: async (replacement) => trackNativeChild(replacement, nativeRecord.binary, nativeRecord,
                    (ownedChild) => { child = ownedChild; }, save),
                  onUnexpectedExit: (nativeChild, code, signal) => {
                    if (!expectedServerShutdowns.has(nativeChild)) cancellation.abort(new Error(`Native Go exited unexpectedly (exit=${code}, signal=${signal}).`));
                  } });
                const afterIdentity = nativeRecord.processIdentity;
                if (afterIdentity === undefined) throw new Error('Restarted native process lacks its persisted identity.');
                const restart: RestartReceipt = { target: 'native', origin: phase.baseUrl, startedAt, readyAt: new Date().toISOString(), before,
                  after: { pid: afterIdentity.pid, start: afterIdentity.startTicks }, binaryOrImage: nativeRecord.binarySha256 };
                (nativeRecord.restarts ??= []).push(restart); await save(); await json(join(combinedDirectory, 'restart.json'), restart); return restart;
              },
              readLogs: async () => {
                const text = Buffer.concat(logs).toString('utf8');
                if (logFailure || text === '' || authFixture === undefined || text.includes(authFixture.appSecret)) throw new Error('Native private authentication log scan failed.');
                return text;
              } });
            sameBrowser(combined, phase.browser); evidence.authCombined!.push(combined); await save();
          } finally { nativeLogSink = undefined; }
        }),
        releaseContainer: () => stage('container-release', async () => {
          cancellation.signal.throwIfAborted();
          if (devCiRunId === undefined) throw new Error('Dev-ci did not announce its owned run before browser release.');
          await writeContainerPermission(containerDirectory, { acceptanceRunId: runId, devCiRunId, sourceGitSha: evidence.source.gitSha });
        }),
        container: () => stage('container', async (ownedRun) => {
          console.log(`Web acceptance ${runId}: preparing the production container through dev-ci gateway.`);
          let runnerOutput = '';
          let runnerIdentitySaved: Promise<void> = Promise.resolve();
          evidence.devCi = {};
          try {
            await ownedRun('bash', ['deployment/dev-ci/run.sh', process.execPath, script, '--container'], {
              timeoutMs: 1_200_000, forceAfterMs: 180_000,
              env: { ...process.env, DAYNIGHT_ACCEPTANCE_DIRECTORY: containerDirectory },
              onOutput: (chunk) => {
                runnerOutput = `${runnerOutput}${chunk}`.slice(-4096);
                const match = /Dev-ci run ID: (\d{14}-\d+-\d{5})/.exec(runnerOutput);
                if (match !== null && devCiRunId === undefined) {
                  devCiRunId = match[1]!;
                  evidence.devCi!.runId = devCiRunId;
                  runnerIdentitySaved = runnerIdentitySaved.then(save);
                  void runnerIdentitySaved.catch(() => {});
                }
              },
              onSpawn: (runnerChild) => {
                runnerIdentitySaved = (async () => {
                  const identity = await processIdentity(runnerChild.pid!);
                  if (identity !== null) evidence.devCi!.runner = identity;
                  await save();
                })();
                void runnerIdentitySaved.catch(() => {});
              },
            });
          } finally { await runnerIdentitySaved; }
          const phase = await readJson(join(containerDirectory, 'target.json')) as BrowserPhase;
          if (phase.browserInventory === undefined) throw new Error('Container browser inventory is missing.');
          if (phase.caseSensitiveStorage !== true) throw new Error('Container case-sensitive storage coverage is missing.');
          await recoverBrowsers(containerDirectory, phase.browserInventory);
          const receiptIdentity = await readJson(join(containerDirectory, 'dev-ci-run.json')) as { runId: string };
          if (receiptIdentity.runId !== devCiRunId) throw new Error('Container receipt differs from the announced dev-ci run.');
          const receipt = await readJson(join(repositoryRoot, '.tmp/dev-ci', receiptIdentity.runId, 'manifest.json')) as Record<string, unknown>;
          evidence.container = receipt;
          if (receipt.result !== 'passed' || receipt.cleanupResult !== 'passed' || !/^sha256:[a-f0-9]{64}$/.test(String(receipt.imageId))) {
            throw new Error('Dev-ci production image or cleanup receipt did not pass.');
          }
          const target: Target = { target: 'container', baseUrl: phase.baseUrl, postgresContainer: phase.postgresContainer,
            projectLabel: phase.projectLabel, database: phase.database, result: 'running', phases: [phase] };
          const rawCombined = await readJson(join(containerDirectory, 'auth-combined/target.json')) as AuthCombinedReceipt;
          const serverId = rawCombined.restart?.containerId;
          if (typeof serverId !== 'string' || !Array.isArray(receipt.containerIds) || !receipt.containerIds.includes(serverId)) throw new Error('Combined container differs from the owned deployment receipt.');
          const combinedTarget: CombinedTarget = { target: 'container', baseUrl: phase.baseUrl, sourceGitSha: evidence.source.gitSha, acceptanceDirectory: directory,
            postgresContainer: phase.postgresContainer, projectLabel: phase.projectLabel, database: 'daynight',
            storage: { kind: 'container', root: '/var/lib/daynight/storage', containerId: serverId, imageId: String(receipt.imageId) } };
          const combined = validateAuthCombinedReceipt(rawCombined, combinedTarget); sameBrowser(combined, phase.browser); evidence.authCombined!.push(combined);
          aggregate(target, functionalScenarios);
          evidence.targets.push(target);
          await save();
        }),
        capacity: () => stage('native-capacity', async () => {
          const phase = nativePhase('capacity');
          await save();
          await playwright(phase, join(directory, 'native/capacity'), installedEvidence());
          evidence.performance = await readJson(join(directory, 'native/capacity/performance.json'));
          validatePerformance(evidence.performance);
          aggregate(native(), [...functionalScenarios, ...capacityScenarios]);
          await save();
        }),
      };
      if (scope === 'all') await runPipeline(cancellation, phases);
      else if (scope === 'native') await runTargetPipeline(cancellation, { target: 'native', preparation: phases.nativePreparation,
        functional: phases.nativeFunctional, capacity: phases.capacity });
      else await runTargetPipeline(cancellation, { target: 'container', preparation: () => stage('cli-preparation', prepareInstallation), container: phases.container });
      const requiredTargets = expectedTargets(scope);
      if (evidence.targets.length !== requiredTargets.length || requiredTargets.some((target) => evidence.targets.filter((entry) => entry.target === target && entry.result === 'passed').length !== 1)
        || evidence.authCombined?.length !== requiredTargets.length
        || requiredTargets.some((target) => evidence.authCombined!.filter((entry) => entry.target === target).length !== 1)) {
        throw new Error('Every selected target must pass its complete browser and authentication journey.');
      }
      evidence.result = 'passed';
    } catch (error) {
      failure = error;
      evidence.result = 'failed';
      evidence.error = error instanceof Error ? error.message : String(error);
    } finally {
      const cleanupFailures: unknown[] = [];
      for (const phaseName of browserDirectories(scope)) {
        try { await recoverBrowserDirectory(join(directory, phaseName), evidence.source.gitSha); }
        catch (error) { cleanupFailures.push(error); }
      }
      if (devCiRunId !== undefined) {
        try {
          evidence.container = await readJson(join(repositoryRoot, '.tmp/dev-ci', devCiRunId, 'manifest.json'));
          if ((evidence.container as Record<string, unknown>).cleanupResult !== 'passed') throw new Error('Dev-ci owned-resource cleanup did not pass.');
        } catch (error) { cleanupFailures.push(error); }
        if (!evidence.targets.some((target) => target.target === 'container')) {
          try {
            const phase = await optionalJson(join(containerDirectory, 'target.json')) as BrowserPhase | undefined;
            if (phase !== undefined) evidence.targets.push({ target: 'container', baseUrl: phase.baseUrl,
              postgresContainer: phase.postgresContainer, projectLabel: phase.projectLabel, database: phase.database,
              result: 'failed', phases: [phase] });
          } catch (error) { cleanupFailures.push(error); }
        }
      }
      for (const target of evidence.targets) if (target.result === 'running') target.result = 'failed';
      if (evidence.installedCli !== undefined) {
        try { await cleanupInstallation(evidence, directory, save); }
        catch (error) { evidence.installedCli.cleanup = 'failed'; cleanupFailures.push(error); }
      }
      if (evidence.scope !== 'container') {
        const beforeNativeCleanup = cleanupFailures.length;
        try { await stopServer(child); } catch (error) { cleanupFailures.push(error); }
        try { await authFixture?.close(); } catch (error) { cleanupFailures.push(error); }
        for (const fixture of nativeEvidence(evidence).authFixtures ?? []) {
          try { await cleanupAuthFixture(fixture, directory); fixture.cleanup = 'passed'; }
          catch (error) { fixture.cleanup = 'failed'; cleanupFailures.push(error); }
        }
        try { await cleanupNativeStorage(nativeEvidence(evidence), runId); }
        catch (error) { cleanupFailures.push(error); }
        try { await cleanupNative(nativeEvidence(evidence)); }
        catch (error) { cleanupFailures.push(error); }
        nativeEvidence(evidence).cleanup = cleanupFailures.length === beforeNativeCleanup ? 'passed' : 'failed';
      }
      evidence.cleanup = cleanupFailures.length === 0 ? 'passed' : 'failed';
      if (cleanupFailures.length > 0) {
        evidence.result = 'failed';
        evidence.cleanupErrors = cleanupFailures.map((error) => error instanceof Error ? error.message : String(error));
        failure = new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupFailures], 'Web acceptance or owned-resource cleanup failed.');
        evidence.error = (failure as Error).message;
      }
      evidence.finishedAt = new Date().toISOString();
      try { await save(); }
      catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Acceptance and final evidence recording failed.'); }
    }
    if (failure === undefined) {
      try { await recordAcceptanceCompletion(evidence, directory); }
      catch (error) {
        failure = error;
        evidence.result = 'failed';
        evidence.error = error instanceof Error ? error.message : String(error);
        try { await save(); }
        catch (recording) { failure = new AggregateError([error, recording], 'Completion and evidence recording failed.'); }
      }
    }
    console.log(`Web acceptance ${runId}: result=${evidence.result}, cleanup=${evidence.cleanup}; evidence=${join(evidenceRoot, 'evidence.json')}`);
    if (failure !== undefined) throw failure;
  };

  return { main, containerCallback, recover };
};

export const runAcceptance = async (cancellation: AbortController, options?: AcceptanceOptions): Promise<void> =>
  createRunner(cancellation, options).main();
export const runContainerCallback = async (cancellation: AbortController): Promise<void> => createRunner(cancellation).containerCallback();
export const recoverAcceptance = async (cancellation: AbortController, runId?: string): Promise<void> => createRunner(cancellation).recover(runId);
