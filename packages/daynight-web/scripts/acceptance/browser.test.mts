import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import * as browserModule from './browser.mts';
import type { Browser, Page } from '@playwright/test';

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

test('functional recovery preserves overlapping navigation with the same executable and its inherited temporary directories', {
  skip: !['linux', 'darwin'].includes(process.platform), timeout: 30_000,
}, async () => {
  const { processIdentity, sameProcess } = await import('./identity.mts');
  const directory = phaseDirectory('container');
  const root = browserModule.browserTemporaryRoot(directory);
  await Promise.all([directory, root].map(path => mkdir(path, { recursive: true })));
  const navigationRoot = await mkdtemp(join(temporaryRoot, 'navigation-ownership-'));
  const executable = join(navigationRoot, 'browser');
  await copyFile(process.execPath, executable);
  const file = await stat(executable, { bigint: true });
  const inventory: browserModule.BrowserInventory = { executables: [await realpath(executable)], profilesBefore: [],
    ...(process.platform === 'darwin' ? { executableFiles: [{ executable: await realpath(executable), device: String(file.dev), inode: String(file.ino) }] } : {}) };
  await writeFile(join(directory, 'inventory.json'), JSON.stringify(inventory));
  const profile = await mkdtemp(join(root, 'playwright_chromiumdev_profile-'));
  const fixture = fileURLToPath(new URL('./navigation-ownership.fixture.mts', import.meta.url));
  const functional = spawn(executable, [fixture, 'functional', directory, executable, `--user-data-dir=${profile}`], {
    detached: true, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, TMPDIR: root, DAYNIGHT_ACCEPTANCE_DIRECTORY: directory },
  });
  let callback: ReturnType<typeof spawn> | undefined;
  try {
    const [output] = await once(functional.stdout!, 'data', { signal: AbortSignal.timeout(10_000) });
    const owned = JSON.parse(String(output)) as browserModule.BrowserOwnership;
    assert.equal(owned.identity.pid, functional.pid);
    const environment: NodeJS.ProcessEnv = { ...process.env, DAYNIGHT_ACCEPTANCE_DIRECTORY: directory, DAYNIGHT_BROWSER_CHANNEL: 'chromium',
      TMPDIR: navigationRoot, TMP: join(navigationRoot, 'tmp'), TEMP: join(navigationRoot, 'temp') };
    callback = spawn(process.execPath, [fixture, 'callback', directory, executable], {
      detached: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: environment,
    });
    const [message] = await once(callback, 'message', { signal: AbortSignal.timeout(10_000) });
    const navigation = message as { identity: browserModule.BrowserOwnership['identity']; profile: string; environment: NodeJS.ProcessEnv };
    assert.equal(navigation.identity.executable, owned.identity.executable);
    assert.notEqual(navigation.identity.group, owned.identity.group);
    await browserModule.recoverBrowsers(directory, inventory);
    assert.equal(await processIdentity(owned.identity.pid), null);
    assert.ok(sameProcess(navigation.identity, await processIdentity(navigation.identity.pid)));
    assert.equal(dirname(navigation.profile), navigationRoot);
    assert.ok((await stat(navigation.profile)).isDirectory());
    assert.equal(Object.hasOwn(navigation.environment, 'DAYNIGHT_ACCEPTANCE_DIRECTORY'), false);
    for (const key of ['DAYNIGHT_BROWSER_CHANNEL', 'PATH', 'TMPDIR', 'TMP', 'TEMP']) assert.equal(navigation.environment[key], environment[key]);
    assert.equal(callback.exitCode, null);
    const exited = once(callback, 'exit'); callback.send('finish');
    assert.deepEqual(await exited, [0, null]);
    assert.equal(await processIdentity(navigation.identity.pid), null);
    await browserModule.recoverBrowsers(directory, inventory);
  } finally {
    for (const child of [callback, functional]) {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
      }
    }
    await rm(navigationRoot, { recursive: true, force: true });
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
    const executable = await realpath(process.execPath);
    const file = await stat(executable, { bigint: true });
    const owner = await browserModule.recordBrowserOwnership(browser, directory, { executables: [executable], profilesBefore: [],
      ...(process.platform === 'darwin' ? { executableFiles: [{ executable, device: String(file.dev), inode: String(file.ino) }] } : {}) });
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

const hardlinkBrowserFixture = async (copied = false) => {
  const directory = phaseDirectory();
  const root = browserModule.browserTemporaryRoot(directory);
  await mkdir(root, { recursive: true });
  await mkdir(directory, { recursive: true });
  const executableRoot = await mkdtemp(join(root, 'executables-'));
  const trusted = join(executableRoot, 'trusted-browser');
  const alias = join(executableRoot, 'cloned-browser');
  const source = join(executableRoot, 'browser.c');
  await writeFile(source, '#include <stdio.h>\n#include <unistd.h>\nint main(void) { puts("ready"); fflush(stdout); for (;;) pause(); }\n');
  execFileSync('/usr/bin/xcrun', ['clang', source, '-o', trusted], { timeout: 30_000 });
  if (copied) await copyFile(trusted, alias);
  else await link(trusted, alias);
  const previous = process.env.DAYNIGHT_BROWSER_EXECUTABLE;
  let inventory: browserModule.BrowserInventory;
  try {
    process.env.DAYNIGHT_BROWSER_EXECUTABLE = trusted;
    inventory = await browserModule.browserInventory(directory);
  } finally {
    if (previous === undefined) delete process.env.DAYNIGHT_BROWSER_EXECUTABLE;
    else process.env.DAYNIGHT_BROWSER_EXECUTABLE = previous;
  }
  const profile = await mkdtemp(join(root, 'playwright_chromiumdev_profile-'));
  const child = spawn(alias, [`--user-data-dir=${profile}`], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DAYNIGHT_ACCEPTANCE_DIRECTORY: directory },
  });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  };
  try { await Promise.race([once(child.stdout!, 'data'), once(child, 'exit').then(([code, signal]) => { throw new Error(`Browser fixture exited before readiness (${code}, ${signal}).`); })]); }
  catch (error) { await close(); throw error; }
  const browser = { newBrowserCDPSession: async () => ({ send: async () => ({ processInfo: [{ type: 'browser', id: child.pid }] }), detach: async () => {} }) } as unknown as Browser;
  return { directory, root, executableRoot, trusted, alias, profile, child, inventory, browser, close,
    cleanup: async () => { await close(); await rm(executableRoot, { recursive: true, force: true }); } };
};

const macOSFixtureOptions = { skip: process.platform !== 'darwin', timeout: 45_000 };
for (const entry of ['combined', 'playwright']) {
  test(`macOS ${entry} entry uses prelaunch inventory and preserves recovery after replacement`, { ...macOSFixtureOptions, timeout: 120_000 }, () => {
    const output = execFileSync(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./browser-entry.fixture.mts', import.meta.url)), entry], {
      encoding: 'utf8', timeout: 110_000,
    });
    assert.match(output, new RegExp(`${entry}: replaced passed`));
  });
}
test('macOS browser recovery recognizes a hard-linked executable from its frozen inventory', macOSFixtureOptions, async () => {
  const f = await hardlinkBrowserFixture();
  try {
    const owner = await browserModule.recordBrowserOwnership(f.browser, f.directory, f.inventory);
    assert.notEqual(owner.identity.executable, f.trusted, 'the real child must exercise an executable path outside the frozen inventory');
    await browserModule.recoverBrowsers(f.directory, f.inventory);
    await browserModule.recoverBrowsers(f.directory, f.inventory);
    await assert.rejects(readFile(join(f.profile, 'daynight-acceptance-owner.json')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('macOS browser recording rejects a byte-identical copy and an expired inventory inode', macOSFixtureOptions, async () => {
  for (const copied of [true, false]) {
    const f = await hardlinkBrowserFixture(copied);
    try {
      if (!copied) f.inventory.executableFiles![0]!.inode = '1';
      await assert.rejects(browserModule.recordBrowserOwnership(f.browser, f.directory, f.inventory), /executable file differs/);
      assert.equal(f.child.exitCode, null);
      assert.equal(f.child.signalCode, null);
      await assert.rejects(readFile(join(f.profile, 'daynight-acceptance-owner.json')), { code: 'ENOENT' });
    } finally { await f.cleanup(); }
  }
});

test('new macOS ownership rejects absent or malformed prelaunch inventories before writing markers', macOSFixtureOptions, async () => {
  const f = await hardlinkBrowserFixture();
  try {
    const file = f.inventory.executableFiles![0]!;
    const previous = process.env.DAYNIGHT_BROWSER_EXECUTABLE;
    process.env.DAYNIGHT_BROWSER_EXECUTABLE = f.trusted;
    try {
      for (const inventory of [undefined, null, {},
        { ...f.inventory, executables: [] }, { ...f.inventory, profilesBefore: [null] },
        { ...f.inventory, executableFiles: undefined }, { ...f.inventory, executableFiles: [] },
        { ...f.inventory, executableFiles: [null] },
        { ...f.inventory, executableFiles: [{ ...file, executable: '/another/browser' }] },
        { ...f.inventory, executableFiles: [{ ...file, inode: 123 }] },
        { ...f.inventory, executableFiles: [{ ...file, device: '-1' }] },
      ]) {
        await assert.rejects(browserModule.recordBrowserOwnership(f.browser, f.directory, inventory as browserModule.BrowserInventory), /inventory/i);
        await assert.rejects(readFile(join(f.profile, 'daynight-acceptance-owner.json')), { code: 'ENOENT' });
        await assert.rejects(readdir(join(f.directory, 'browser-processes')), { code: 'ENOENT' });
        assert.equal(f.child.exitCode, null); assert.equal(f.child.signalCode, null);
      }
    } finally { if (previous === undefined) delete process.env.DAYNIGHT_BROWSER_EXECUTABLE; else process.env.DAYNIGHT_BROWSER_EXECUTABLE = previous; }
  } finally { await f.cleanup(); }
});

test('macOS recovery accepts a live executable hard-link path that differs from its receipt', macOSFixtureOptions, async () => {
  const f = await hardlinkBrowserFixture();
  try {
    const owner = await browserModule.recordBrowserOwnership(f.browser, f.directory, f.inventory);
    const previousPath = join(f.executableRoot, 'previous-browser-path');
    await link(f.trusted, previousPath);
    const earlier = { ...owner, identity: { ...owner.identity, executable: previousPath } };
    await writeFile(join(f.directory, 'browser-processes', `${owner.identity.pid}-${owner.identity.startTicks}.json`), JSON.stringify(earlier));
    await writeFile(join(f.profile, 'daynight-acceptance-owner.json'), JSON.stringify(earlier));
    await rm(previousPath);
    await browserModule.recoverBrowsers(f.directory, f.inventory);
    await assert.rejects(readFile(join(f.profile, 'daynight-acceptance-owner.json')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('macOS recovery remains idempotent after the recorded executable links disappear on exit', macOSFixtureOptions, async () => {
  const f = await hardlinkBrowserFixture();
  try {
    await browserModule.recordBrowserOwnership(f.browser, f.directory, f.inventory);
    await f.close();
    await rm(f.executableRoot, { recursive: true });
    await browserModule.recoverBrowsers(f.directory, f.inventory);
    await browserModule.recoverBrowsers(f.directory, f.inventory);
    await assert.rejects(readFile(join(f.profile, 'daynight-acceptance-owner.json')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('macOS recovery refuses an active browser when its executable file cannot be revalidated', macOSFixtureOptions, async () => {
  const f = await hardlinkBrowserFixture();
  try {
    await browserModule.recordBrowserOwnership(f.browser, f.directory, f.inventory);
    await rm(f.executableRoot, { recursive: true });
    await assert.rejects(browserModule.recoverBrowsers(f.directory, f.inventory), /Cannot read executable|ENOENT/);
    assert.equal(f.child.exitCode, null);
    assert.equal(f.child.signalCode, null);
    assert.ok(await readFile(join(f.profile, 'daynight-acceptance-owner.json')));
  } finally { await f.cleanup(); }
});

test('macOS hard-link inventory does not authorize an unrecorded browser group', macOSFixtureOptions, async () => {
  const f = await hardlinkBrowserFixture();
  let unrecorded: ReturnType<typeof spawn> | undefined;
  try {
    await browserModule.recordBrowserOwnership(f.browser, f.directory, f.inventory);
    unrecorded = spawn(f.alias, [], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, DAYNIGHT_ACCEPTANCE_DIRECTORY: f.directory } });
    await once(unrecorded.stdout!, 'data');
    await assert.rejects(browserModule.recoverBrowsers(f.directory, f.inventory), /Unrecorded Chromium startup process/);
    for (const child of [f.child, unrecorded]) {
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
    }
  } finally {
    if (unrecorded !== undefined && unrecorded.exitCode === null && unrecorded.signalCode === null) {
      const exited = once(unrecorded, 'exit'); unrecorded.kill('SIGKILL'); await exited;
    }
    await f.cleanup();
  }
});

test('macOS executable aliases retain run, profile, marker, and frozen inventory checks', macOSFixtureOptions, async () => {
  const f = await hardlinkBrowserFixture();
  try {
    const owner = await browserModule.recordBrowserOwnership(f.browser, f.directory, f.inventory);
    const receipt = join(f.directory, 'browser-processes', `${owner.identity.pid}-${owner.identity.startTicks}.json`);
    const marker = join(f.profile, 'daynight-acceptance-owner.json');
    for (const invalid of [
      { ...owner, directory: phaseDirectory() },
      { ...owner, profile: join(browserModule.browserTemporaryRoot(phaseDirectory()), 'playwright_chromiumdev_profile-ABC123') },
      { ...owner, executableFile: { ...owner.executableFile!, inode: '1' } },
    ]) {
      await writeFile(receipt, JSON.stringify(invalid));
      await assert.rejects(browserModule.recoverBrowsers(f.directory, f.inventory), /receipt ownership differs/);
      assert.equal(f.child.exitCode, null);
      assert.equal(f.child.signalCode, null);
    }
    await writeFile(receipt, JSON.stringify(owner));
    await writeFile(marker, JSON.stringify({ ...owner, executableFile: undefined }));
    await assert.rejects(browserModule.recoverBrowsers(f.directory, f.inventory), /ownership marker/);
    assert.equal(f.child.signalCode, null);
    await writeFile(marker, JSON.stringify(owner));
    await browserModule.recoverBrowsers(f.directory, f.inventory);
  } finally { await f.cleanup(); }
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
    const unrelatedInventory = await browserModule.browserInventory(unrelatedDirectory);
    unrelated = await launch(unrelatedDirectory);
    owned = await launch(directory);
    await owned.newPage();
    const ownership = await browserModule.recordBrowserOwnership(owned, directory, inventory);
    const unrelatedOwner = await browserModule.recordBrowserOwnership(unrelated, unrelatedDirectory, unrelatedInventory);
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
    const owner = await browserModule.recordBrowserOwnership(browser, directory, inventory);
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

test('viewport synchronization preserves an emulated resize failure without opening a protocol session', async () => {
  const failure = new Error('Emulated resize refused.');
  let contextRead = false;
  const page = { setViewportSize: async () => { throw failure; }, context: () => { contextRead = true; } } as unknown as Page;
  await assert.rejects(browserModule.setBrowserViewport(page, { width: 320, height: 240 }), error => error === failure);
  assert.equal(contextRead, false);
});

test('macOS viewport synchronization reports native failures and detaches its protocol session', { skip: process.platform !== 'darwin' }, async () => {
  for (const failedMethod of ['Browser.getWindowForTarget', 'Browser.setContentsSize']) {
    const failure = new Error('Native contents resize refused.');
    let detached = false;
    const page = {
      setViewportSize: async () => {},
      context: () => ({ newCDPSession: async () => ({
        send: async (method: string) => { if (method === failedMethod) throw failure; return { windowId: 17 }; },
        detach: async () => { detached = true; },
      }) }),
    } as unknown as Page;
    await assert.rejects(browserModule.setBrowserViewport(page, { width: 320, height: 240 }), error => error === failure);
    assert.equal(detached, true);
  }
});

test('pinned Chromium keeps wheel input usable across the entire short viewport without resizing another browser', {
  skip: process.env.DAYNIGHT_TEST_PINNED_BROWSER !== '1', timeout: 30_000,
}, async () => {
  const { chromium, expect } = await import('@playwright/test');
  const directory = phaseDirectory();
  const siblingDirectory = phaseDirectory();
  const browsers: Browser[] = [];
  const launch = async (directory: string): Promise<Browser> => {
    const root = browserModule.browserTemporaryRoot(directory);
    await mkdir(root, { recursive: true });
    const previous = process.env.TMPDIR;
    try {
      process.env.TMPDIR = root;
      const browser = await chromium.launch({ channel: 'chromium', headless: true,
        env: { ...process.env, TMPDIR: '.tmp', DAYNIGHT_ACCEPTANCE_DIRECTORY: directory } });
      browsers.push(browser);
      return browser;
    } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  };
  try {
    const browser = await launch(directory);
    const sibling = await launch(siblingDirectory);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const other = await sibling.newPage({ viewport: { width: 800, height: 600 } });
    const otherSession = await other.context().newCDPSession(other);
    const previousWindow = await otherSession.send('Browser.getWindowForTarget');
    try {
      for (const lowerEdge of [false, true]) {
        await page.setContent('<!doctype html><style>body{margin:0}#reading{position:absolute;bottom:0;height:135px;width:100%;overflow:auto}</style><div id="reading"><div style="height:1800px">Long reading content</div></div>');
        await browserModule.setBrowserViewport(page, { width: 320, height: 240 });
        assert.deepEqual(page.viewportSize(), { width: 320, height: 240 });
        assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 320, height: 240 });
        const owner = page.locator('#reading');
        assert.equal(await owner.evaluate(element => element.scrollTop), 0);
        await owner.hover(lowerEdge ? { position: { x: 160, y: 127 } } : {});
        await page.mouse.wheel(0, 600);
        await expect.poll(() => owner.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        assert.deepEqual(await otherSession.send('Browser.getWindowForTarget'), previousWindow);
        assert.deepEqual(await other.evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 800, height: 600 });
      }
    } finally { await otherSession.detach(); }
  } finally { await Promise.all(browsers.map(browser => browser.close())); }
});
