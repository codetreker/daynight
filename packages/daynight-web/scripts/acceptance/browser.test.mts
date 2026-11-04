import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import * as browserModule from './browser.mts';
import type { Browser } from '@playwright/test';

const temporaryRoot = fileURLToPath(new URL('../../.tmp/', import.meta.url));
const runs = new Set<string>();
const phaseDirectory = (phase = 'native/functional'): string => {
  const run = join(temporaryRoot, 'acceptance', `20261104123456-${randomUUID()}`);
  runs.add(run);
  return join(run, phase);
};
after(async () => {
  await Promise.all([...runs].flatMap((run) => [run, join(temporaryRoot, 'acceptance-private', basename(run))])
    .map((path) => rm(path, { recursive: true, force: true })));
});
const directory = phaseDirectory();
const root = browserModule.browserTemporaryRoot(directory);

test('browser profile extraction preserves canonical argument boundaries and space-containing paths', () => {
  const profile = join(root, 'playwright_chromiumdev_profile-spaces in ABC123');
  assert.equal(browserModule.browserProfile(['/opt/chromium/chrome', '', 'Unicode \u96ea', '--unrelated=--user-data-dir=foreign', `--user-data-dir=${profile}`], directory), profile);
  assert.throws(() => browserModule.browserProfile([`--user-data-dir=${profile}`], directory), /Chromium profile/);
  for (const arguments_ of [null, [], ['/opt/chromium/chrome'], ['/opt/chromium/chrome', '--user-data-dir='],
    ['/opt/chromium/chrome', `--user-data-dir=${profile}`, `--user-data-dir=${profile}`]]) {
    assert.throws(() => browserModule.browserProfile(arguments_, directory), /Chromium profile/);
  }
});

test('browser profile extraction accepts the Chromium singleton process-title switch shape', () => {
  const title = '/opt/chromium/chrome --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-client-side-phishing-detection --disable-component-extensions-with-background-pages --disable-component-update --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --disable-edgeupdater --disable-extensions --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,AvoidCorsURLLoaderRestartOnRedirect,Translate,AutoDeElevate,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion --enable-features=CDPScreenshotNewSurface --allow-pre-commit-input --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --disable-updater-scheduler --force-color-profile=srgb --metrics-recording-only --no-first-run --password-store=basic --use-mock-keychain --no-service-autorun --export-tagged-pdf --disable-search-engine-choice-screen --unsafely-disable-devtools-self-xss-warnings --edge-skip-compat-layer-relaunch --disable-infobars --disable-search-engine-choice-screen --disable-sync --enable-unsafe-swiftshader --headless --hide-scrollbars --mute-audio --blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4 --no-sandbox --user-data-dir=./playwright_chromiumdev_profile-STfjbB --remote-debugging-pipe --no-startup-window --noerrdialogs --ozone-platform=headless --ozone-override-screen-size=800,600 --use-angle=swiftshader-webgl';
  const workingDirectory = root;
  assert.equal(browserModule.browserProfile([title], directory, workingDirectory), join(root, 'playwright_chromiumdev_profile-STfjbB'));
  const absolute = join(root, 'playwright_chromiumdev_profile-ABC123');
  assert.equal(browserModule.browserProfile([`/opt/chromium/chrome --headless --user-data-dir=${absolute} --remote-debugging-pipe`], directory), absolute);
  assert.throws(() => browserModule.browserProfile([title, '--headless'], directory, workingDirectory), /Chromium profile/);
});

test('browser profile extraction rejects ambiguous, truncated and foreign singleton titles', () => {
  const profile = join(root, 'playwright_chromiumdev_profile-ABC123');
  const titles = [
    '/opt/chromium/chrome --headless',
    '/opt/chromium/chrome --user-data-dir= --headless',
    '/opt/chromium/chrome --user-data-dir --headless',
    `/opt/chromium/chrome --user-data-dir=${profile} --user-data-dir=${profile} --headless`,
    `/opt/chromium/chrome --user-data-dir=${profile} --user-data-dir= --headless`,
    `/opt/chromium/chrome --user-data-dir=${profile} --user-data-dir --headless`,
    `/opt/chromium/chrome --user-data-dir="${profile}" --headless`,
    `/opt/chromium/chrome --user-data-dir='${profile}' --headless`,
    `/opt/chromium/chrome --user-data-dir=${profile} extra --headless`,
    `/opt/chromium/chrome --user-data-dir=${profile} spaces --remote-debugging-pipe`,
    `/opt/chromium/chrome --user-data-dir=${profile}`,
    `/opt/chromium/chrome --user-data-dir=${profile} --`,
    `/opt/chromium/chrome --user-data-dir=${join(root, 'playwright_chromiumdev_profile-ABC12')} --headless`,
    '/opt/chromium/chrome --user-data-dir=/tmp/playwright_chromiumdev_profile-ABC123 --headless',
    `/opt/chromium/chrome --user-data-dir=${join(root, 'foreign-ABC123')} --headless`,
    `/opt/chromium/chrome --value=--user-data-dir=${profile} --headless`,
    `/opt/chromium/chrome --value=--user-data-dir=${profile} --user-data-dir=${profile} --headless`,
    `/opt/chromium/chrome --value="text --user-data-dir=${profile}" --headless`,
    `/opt/chromium/chrome --value="text" --user-data-dir=${profile} --headless`,
    `/opt/chromium/chrome\t--user-data-dir=${profile} --headless`,
  ];
  for (const title of titles) assert.throws(() => browserModule.browserProfile([title], directory), /Chromium profile/, title);
});

test('phase roots are private, distinct, and derived only from canonical acceptance directories', () => {
  const native = phaseDirectory();
  const container = join(dirname(dirname(native)), 'container');
  const nativeRoot = browserModule.browserTemporaryRoot(native);
  const containerRoot = browserModule.browserTemporaryRoot(container);
  assert.notEqual(nativeRoot, containerRoot);
  assert.ok(nativeRoot.startsWith(join(temporaryRoot, 'acceptance-private') + '/'));
  assert.ok(containerRoot.startsWith(join(temporaryRoot, 'acceptance-private') + '/'));
  assert.throws(() => browserModule.browserProfile(['/opt/chromium/chrome', `--user-data-dir=${join(containerRoot, 'playwright_chromiumdev_profile-ABC123')}`], native), /owned temporary directory/);
  for (const invalid of ['relative', join(temporaryRoot, 'foreign'), join(dirname(native), 'other'), `${native}/../functional`]) {
    assert.throws(() => browserModule.browserTemporaryRoot(invalid), /outside an owned acceptance run/);
  }
});

test('recovery preserves sibling startup profiles and rejects an unrecorded profile in its own phase', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  const native = phaseDirectory();
  const container = join(dirname(dirname(native)), 'container');
  const nativeRoot = browserModule.browserTemporaryRoot(native);
  const containerRoot = browserModule.browserTemporaryRoot(container);
  await Promise.all([nativeRoot, containerRoot].map((path) => mkdir(path, { recursive: true })));
  const siblingProfile = await mkdtemp(join(containerRoot, 'playwright_chromiumdev_profile-'));
  const siblingMarker = join(siblingProfile, 'private-session');
  await writeFile(siblingMarker, 'sibling cookie jar');
  const sibling = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], {
    detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, DAYNIGHT_ACCEPTANCE_DIRECTORY: container },
  });
  try {
    await once(sibling.stdout!, 'data');
    const inventory = { executables: [await realpath(process.execPath)], profilesBefore: [] };
    await browserModule.recoverBrowsers(native, inventory);
    assert.equal(sibling.exitCode, null);
    assert.equal(sibling.signalCode, null);
    assert.equal(await readFile(siblingMarker, 'utf8'), 'sibling cookie jar');
    await mkdir(nativeRoot, { recursive: true });
    const uncertainProfile = await mkdtemp(join(nativeRoot, 'playwright_chromiumdev_profile-'));
    await assert.rejects(browserModule.recoverBrowsers(native, inventory), /Unrecorded Chromium profile/);
    await rm(uncertainProfile, { recursive: true });
    await browserModule.recoverBrowsers(native, inventory);
    assert.equal(await readFile(siblingMarker, 'utf8'), 'sibling cookie jar');
  } finally {
    if (sibling.exitCode === null && sibling.signalCode === null) { const exited = once(sibling, 'exit'); sibling.kill('SIGKILL'); await exited; }
    await rm(join(temporaryRoot, 'acceptance-private', basename(dirname(dirname(native)))), { recursive: true, force: true });
  }
});

test('browser ownership reads exact argv with a profile containing spaces', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  await mkdir(root, { recursive: true });
  const profile = await mkdtemp(join(root, 'playwright_chromiumdev_profile-spaces in '));
  await mkdir(directory, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)', '--', `--user-data-dir=${profile}`], {
    detached: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    await once(child.stdout!, 'data');
    const browser = { newBrowserCDPSession: async () => ({ send: async () => ({ processInfo: [{ type: 'browser', id: child.pid }] }), detach: async () => {} }) } as unknown as Browser;
    const owner = await browserModule.recordBrowserOwnership(browser, directory);
    assert.equal(owner.profile, profile);
    assert.deepEqual(JSON.parse(await readFile(join(profile, 'daynight-acceptance-owner.json'), 'utf8')), owner);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await Promise.all([rm(profile, { recursive: true, force: true }), rm(directory, { recursive: true, force: true })]);
  }
});

test('browser inventory includes only exact executables from its macOS bundle', async () => {
  await mkdir(root, { recursive: true });
  const fixture = await mkdtemp(join(root, 'browser-bundle-'));
  const app = join(fixture, 'Google Chrome for Testing.app');
  const executable = join(app, 'Contents/MacOS/Google Chrome for Testing');
  const helpers = join(app, 'Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/151/Helpers');
  const expected = [executable, join(helpers, 'chrome_crashpad_handler'), ...['', ' (Renderer)', ' (GPU)', ' (Alerts)'].map((suffix) => join(helpers, `Google Chrome for Testing Helper${suffix}.app/Contents/MacOS/Google Chrome for Testing Helper${suffix}`))];
  const unrelated = join(fixture, 'Other Chrome.app/Contents/MacOS/Other Chrome');
  try {
    for (const path of [...expected, unrelated, join(helpers, 'app_mode_loader')]) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, '', { mode: 0o700 }); }
    assert.equal(typeof (browserModule as Record<string, unknown>).browserExecutables, 'function', 'bundle executable inventory API is required');
    const inventory = await (browserModule as typeof browserModule & { browserExecutables(path: string): Promise<string[]> }).browserExecutables(executable);
    assert.deepEqual(inventory.sort(), (await Promise.all(expected.map((path) => realpath(path)))).sort());
    assert.equal(inventory.some((path) => basename(path) === 'app_mode_loader'), false);
    assert.equal(inventory.includes(unrelated), false);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('pinned Chromium bundle processes recover using recorded ownership and preserve another browser', {
  skip: process.env.DAYNIGHT_TEST_PINNED_BROWSER !== '1', timeout: 45_000,
}, async () => {
  const { chromium } = await import('@playwright/test');
  const { findProcesses, processIdentity } = await import('./identity.mts');
  const directory = phaseDirectory();
  const unrelatedDirectory = join(dirname(dirname(directory)), 'container');
  await Promise.all([directory, unrelatedDirectory].map((path) => mkdir(path, { recursive: true })));
  const root = browserModule.browserTemporaryRoot(directory);
  const unrelatedRoot = browserModule.browserTemporaryRoot(unrelatedDirectory);
  await Promise.all([root, unrelatedRoot].map((path) => mkdir(path, { recursive: true })));
  const launch = async (directory: string): Promise<Browser> => {
    const previous = process.env.TMPDIR;
    try {
      process.env.TMPDIR = browserModule.browserTemporaryRoot(directory);
      return await chromium.launch({ channel: 'chromium', headless: true,
        env: { ...process.env, TMPDIR: '.tmp', DAYNIGHT_ACCEPTANCE_DIRECTORY: directory } });
    } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  };
  let unrelated: Browser | undefined;
  let owned: Browser | undefined;
  try {
    const inventory = await browserModule.browserInventory(directory);
    unrelated = await launch(unrelatedDirectory);
    owned = await launch(directory);
    await owned.newPage();
    const ownership = await browserModule.recordBrowserOwnership(owned, directory);
    const unrelatedOwner = await browserModule.recordBrowserOwnership(unrelated, unrelatedDirectory);
    const processes = await findProcesses({ DAYNIGHT_ACCEPTANCE_DIRECTORY: directory });
    assert.ok(processes.length > 1, 'native Chromium must expose its renderer/helper process');
    assert.ok(processes.every((process) => inventory.executables.includes(process.executable)), JSON.stringify(processes));
    if (process.platform === 'darwin') {
      assert.ok(ownership.companions.length > 0, 'macOS Crashpad has its own process group');
      const receipt = join(directory, 'browser-processes', `${ownership.identity.pid}-${ownership.identity.startTicks}.json`);
      await writeFile(receipt, JSON.stringify({ ...ownership, companions: [] }));
      await assert.rejects(browserModule.recoverBrowsers(directory, inventory), /Unrecorded Chromium startup process/);
      assert.ok(await processIdentity(ownership.identity.pid));
      assert.ok(await processIdentity(unrelatedOwner.identity.pid));
      await writeFile(receipt, JSON.stringify(ownership));
    }
    await browserModule.recoverBrowsers(directory, inventory);
    assert.equal(await processIdentity(ownership.identity.pid), null);
    await browserModule.recoverBrowsers(directory, inventory);
    await assert.rejects(readFile(join(ownership.profile, 'daynight-acceptance-owner.json')), { code: 'ENOENT' });
    assert.ok(await processIdentity(unrelatedOwner.identity.pid));
    assert.equal((await unrelated.newPage()).isClosed(), false);
  } finally {
    await Promise.all([owned?.close().catch(() => {}), unrelated?.close()]);
    await Promise.all([directory, unrelatedDirectory, root, unrelatedRoot].map((path) => rm(path, { recursive: true, force: true })));
  }
});

test('normally closed pinned Chromium cleans its auto-created profile from the complete receipt', {
  skip: process.env.DAYNIGHT_TEST_PINNED_BROWSER !== '1', timeout: 30_000,
}, async () => {
  const { chromium } = await import('@playwright/test');
  const directory = phaseDirectory();
  await mkdir(directory, { recursive: true });
  const root = browserModule.browserTemporaryRoot(directory);
  const inventory = await browserModule.browserInventory(directory);
  const previousTemporary = process.env.TMPDIR;
  let browser: Browser | undefined;
  let profile: string | undefined;
  try {
    process.env.TMPDIR = root;
    browser = await chromium.launch({ channel: 'chromium', headless: true, env: { ...process.env, TMPDIR: '.tmp', DAYNIGHT_ACCEPTANCE_DIRECTORY: directory } });
    if (previousTemporary === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTemporary;
    const owner = await browserModule.recordBrowserOwnership(browser, directory);
    profile = owner.profile;
    await browser.close();
    await browserModule.recoverBrowsers(directory, inventory);
    await assert.rejects(readFile(join(profile, 'daynight-acceptance-owner.json')), { code: 'ENOENT' });
  } finally {
    if (previousTemporary === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTemporary;
    await browser?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
    if (profile !== undefined) await rm(profile, { recursive: true, force: true });
  }
});
