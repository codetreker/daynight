import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { basename, join } from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Browser } from '@playwright/test';
import type * as BrowserModule from './browser.mts';
import * as identity from './identity.mts';

// Native Node resolves the extensionless imports used by Playwright's TS loader.
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

type EvidenceFixture = (input: Record<string, unknown>, use: () => Promise<void>) => Promise<void>;
let evidence: EvidenceFixture;
let launch: () => Promise<Browser>;
mock.module('@playwright/test', { exports: {
  test: { extend: (fixtures: { acceptanceEvidence: [EvidenceFixture] }) => { evidence = fixtures.acceptanceEvidence[0]; return {}; } },
  chromium: { launch: () => launch() },
  expect: (value: unknown) => ({ toEqual: (expected: unknown) => assert.deepEqual(value, expected), toBe: (expected: unknown) => assert.equal(value, expected) }),
  request: {},
} });
mock.module(new URL('./installed-cli.mts', import.meta.url).href, { exports: {
  validateInstalledCli: async () => ({ packageVersion: '1.0.0', source: { gitSha: 'a'.repeat(40) }, entrySha256: 'b'.repeat(64), tarballSha256: 'c'.repeat(64) }),
  createAcceptanceCli: () => { throw new Error('Authentication business work is outside this startup fixture.'); },
} });
mock.module(new URL('./auth-combined-target.mts', import.meta.url).href, { exports: { createAuthCombinedTarget: () => ({}) } });
mock.module(new URL('../../src/api/client.ts', import.meta.url).href, { exports: { attachmentDownloadUrl: () => '' } });

const children = new Map<ChildProcess, string>();
const observed = async (directory: string, executables?: readonly string[]) => {
  const result: identity.ProcessIdentity[] = [];
  for (const [child, owner] of children) {
    if (owner !== directory) continue;
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const current = await identity.processIdentity(child.pid!);
    if (current !== null && (executables === undefined || executables.includes(current.executable))) result.push(current);
  }
  return result;
};
// Discovery is limited to this child's fixtures; PID/start/group/argv stay native.
mock.module(new URL('./identity.mts', import.meta.url).href, { exports: { ...identity,
  findProcesses: (environment: Record<string, string>) => observed(environment.DAYNIGHT_ACCEPTANCE_DIRECTORY!),
  ownedBrowserProcesses: observed,
} });
const browsers = await import('./browser.mts');

const entry = process.argv[2];
assert.ok(entry === 'combined' || entry === 'playwright');
const { runAuthCombined } = await import('./auth-combined.mts');
await import('../../tests/e2e/fixtures.ts');
const temporaryRoot = fileURLToPath(new URL('../../.tmp/', import.meta.url));
const cases = entry === 'combined' ? ['unchanged', 'replaced', 'close-failed', 'profile-left']
  : ['unchanged', 'replaced', 'close-failed', 'profile-left', 'missing', 'invalid', 'missing-target', 'malformed-target'];

for (const scenario of cases) {
  const run = join(temporaryRoot, 'acceptance', `20261105123456-${randomUUID()}`);
  const directory = join(run, entry === 'combined' ? 'native/auth-combined' : 'native/functional');
  const root = browsers.browserTemporaryRoot(directory);
  const executableRoot = join(run, 'executables');
  await mkdir(executableRoot, { recursive: true });
  await mkdir(directory, { recursive: true });
  await mkdir(root, { recursive: true });
  const executable = join(executableRoot, 'browser');
  const source = join(executableRoot, 'browser.c');
  await writeFile(source, '#include <stdio.h>\n#include <unistd.h>\nint main(void) { puts("ready"); fflush(stdout); for (;;) pause(); }\n');
  execFileSync('/usr/bin/xcrun', ['clang', source, '-o', executable], { timeout: 30_000 });
  process.env.DAYNIGHT_BROWSER_EXECUTABLE = executable;
  process.env.DAYNIGHT_ACCEPTANCE_DIRECTORY = directory;
  const inventory = await browsers.browserInventory(directory);
  let child: ChildProcess | undefined;
  let profile = '';
  let closeCalls = 0;
  let contextCalls = 0;
  const stop = async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  };
  const start = async (): Promise<Browser> => {
    profile = await mkdtemp(join(root, 'playwright_chromiumdev_profile-'));
    child = spawn(executable, [`--user-data-dir=${profile}`], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DAYNIGHT_ACCEPTANCE_DIRECTORY: directory },
    });
    children.set(child, directory);
    await Promise.race([once(child.stdout!, 'data'), once(child, 'exit').then(() => { throw new Error('Native fixture exited before readiness.'); })]);
    return {
      newBrowserCDPSession: async () => ({ send: async () => ({ processInfo: [{ type: 'browser', id: child!.pid }] }), detach: async () => {} }),
      close: async () => {
        closeCalls++;
        if (scenario === 'close-failed') throw new Error('Fixture browser close failed.');
        await stop();
        if (scenario !== 'profile-left') await rm(profile, { recursive: true, force: true });
      },
      browserType: () => ({ name: () => 'chromium' }), version: () => '1.2.3.4',
      newContext: async () => { contextCalls++; throw new Error('Startup verified; business scenarios intentionally stop here.'); },
    } as unknown as Browser;
  };
  try {
    // Keep a valid earlier receipt to prove rejection does not erase other owners.
    const earlier = await start();
    const earlierOwner = await browsers.recordBrowserOwnership(earlier, directory, inventory);
    await stop(); await rm(profile, { recursive: true });
    const receiptPath = join(directory, 'browser-processes', `${earlierOwner.identity.pid}-${earlierOwner.identity.startTicks}.json`);
    const earlierBytes = await readFile(receiptPath, 'utf8');
    let savedInventory = inventory;
    launch = async () => {
      if (entry === 'combined') {
        savedInventory = (JSON.parse(await readFile(join(directory, 'target.json'), 'utf8')) as { browserInventory: BrowserModule.BrowserInventory }).browserInventory;
        assert.deepEqual(savedInventory.executableFiles, inventory.executableFiles);
      }
      if (['replaced', 'close-failed', 'profile-left'].includes(scenario)) {
        await copyFile(executable, `${executable}.next`);
        await rename(`${executable}.next`, executable);
      }
      return await start();
    };
    if (entry === 'combined') {
      await assert.rejects(runAuthCombined({ directory, installedReceiptPath: join(run, 'installed-cli.json'), signal: new AbortController().signal,
        target: { target: 'native', acceptanceDirectory: run, baseUrl: 'http://127.0.0.1:12345', sourceGitSha: 'a'.repeat(40),
          postgresContainer: 'unused', projectLabel: { key: 'unused', value: 'unused' }, database: 'daynight', storage: { kind: 'native', root: join(run, 'data') } },
        restartTarget: async () => { throw new Error('Startup fixture must not restart a server.'); }, readLogs: async () => '',
      }));
      const receipt = JSON.parse(await readFile(join(directory, 'target.json'), 'utf8')) as { cleanup: string; browserCleanup: string; cleanupErrors?: string[] };
      assert.equal(closeCalls, 1, 'the combined caller closes its launched browser after recording failure');
      assert.equal(contextCalls, scenario === 'unchanged' ? 1 : 0, 'replaced executable must fail before business browser contexts');
      if (scenario === 'close-failed' || scenario === 'profile-left') {
        assert.equal(receipt.cleanup, 'failed'); assert.equal(receipt.browserCleanup, 'failed');
        if (scenario === 'close-failed') assert.ok(receipt.cleanupErrors!.includes('Browser close failed.'));
      } else { assert.equal(receipt.cleanup, 'passed'); assert.equal(receipt.browserCleanup, 'passed'); }
    } else {
      if (scenario !== 'missing-target') await writeFile(join(directory, 'target.json'), scenario === 'malformed-target' ? '{' : JSON.stringify(scenario === 'missing' ? {} : {
        browserInventory: scenario === 'invalid' ? { ...inventory, executableFiles: [] } : inventory,
      }));
      const browser = await launch();
      let used = false;
      const operation = evidence!({ browser, page: { on: () => {} }, attachmentWritePolicy: { allowed: new Map(), statuses: new Map(), unexpected: [] } }, async () => { used = true; });
      if (scenario === 'unchanged') await operation;
      else await assert.rejects(operation, /inventory|target\.json|JSON/i);
      assert.equal(used, scenario === 'unchanged', 'a rejected owner cannot enter the test body');
      // Playwright owns browser fixture teardown even when an automatic fixture fails.
      if (scenario === 'close-failed') await assert.rejects(browser.close(), /close failed/);
      else await browser.close();
    }
    assert.equal(await readFile(receiptPath, 'utf8'), earlierBytes, 'the earlier valid receipt is unchanged');
    if (scenario !== 'unchanged') {
      assert.deepEqual(await readdir(join(directory, 'browser-processes')), [basename(receiptPath)], 'a refused browser adds no process receipt');
      await assert.rejects(readFile(join(profile, 'daynight-acceptance-owner.json')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(directory, 'browser.json')), { code: 'ENOENT' });
    }
    if (scenario === 'close-failed') {
      assert.equal(child!.exitCode, null); assert.equal(child!.signalCode, null);
      await assert.rejects(browsers.recoverBrowsers(directory, savedInventory), /Unrecorded Chromium startup process/);
      await stop();
    }
    if (scenario === 'close-failed' || scenario === 'profile-left') {
      await assert.rejects(browsers.recoverBrowsers(directory, savedInventory), /Unrecorded Chromium profile/);
      await rm(profile, { recursive: true });
    }
    await browsers.recoverBrowsers(directory, savedInventory);
    await browsers.recoverBrowsers(directory, savedInventory);
    process.stdout.write(`${entry}: ${scenario} passed\n`);
  } finally {
    await stop();
    await rm(run, { recursive: true, force: true });
    await rm(join(temporaryRoot, 'acceptance-private', basename(run)), { recursive: true, force: true });
  }
}
