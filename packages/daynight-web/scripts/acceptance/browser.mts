import { createRequire } from 'node:module';
import { access, mkdir, readFile, readdir, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findProcesses, isGroupStopped, ownedBrowserProcesses, processArguments, processIdentity, requireGroupStopped, sameProcess, type ProcessIdentity } from './identity.mts';
import type { Browser, Page } from '@playwright/test';

export const setBrowserViewport = async (page: Page, viewport: { width: number; height: number }): Promise<void> => {
  await page.setViewportSize(viewport);
  if (process.platform !== 'darwin') return;
  // Headless macOS window bounds can include browser chrome while the emulated
  // viewport does not. Size native contents without guessing a frame inset.
  const session = await page.context().newCDPSession(page);
  try {
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setContentsSize', { windowId, ...viewport });
  } finally { await session.detach(); }
};

type BrowserExecutableFile = { executable: string; device: string; inode: string };
export type BrowserOwnership = { directory: string; identity: ProcessIdentity; profile: string; companions: ProcessIdentity[]; executableFile?: BrowserExecutableFile };
export type BrowserInventory = { executables: string[]; profilesBefore: string[]; executableFiles?: BrowserExecutableFile[] };
const executableFile = async (executable: string): Promise<BrowserExecutableFile> => {
  const file = await stat(executable, { bigint: true });
  if (!file.isFile()) throw new Error('Browser executable is not a regular file.');
  return { executable, device: String(file.dev), inode: String(file.ino) };
};
const sameFile = (left: BrowserExecutableFile, right: BrowserExecutableFile): boolean => left.device === right.device && left.inode === right.inode;
const sameFileRecord = (left: BrowserExecutableFile | undefined, right: BrowserExecutableFile | undefined): boolean =>
  left === undefined ? right === undefined : right !== undefined && left.executable === right.executable && sameFile(left, right);
const inventoriedFile = (file: BrowserExecutableFile, inventory: BrowserInventory): boolean => process.platform === 'darwin'
  && inventory.executables.includes(file.executable) && inventory.executableFiles?.some((expected) => sameFileRecord(expected, file)) === true;
const sameBrowserProcess = async (expected: ProcessIdentity, observed: ProcessIdentity | null, file?: BrowserExecutableFile): Promise<boolean> => {
  if (file === undefined) return sameProcess(expected, observed);
  if (observed === null || expected.platform !== observed.platform || expected.pid !== observed.pid
    || expected.startTicks !== observed.startTicks || expected.group !== observed.group) return false;
  return sameFile(file, await executableFile(observed.executable));
};
const observedBrowsers = async (directory: string, inventory: BrowserInventory): Promise<ProcessIdentity[]> => {
  if (process.platform !== 'darwin' || inventory.executableFiles === undefined) return await ownedBrowserProcesses(directory, inventory.executables);
  const result: ProcessIdentity[] = [];
  for (const identity of await findProcesses({ DAYNIGHT_ACCEPTANCE_DIRECTORY: directory })) {
    if (inventory.executables.includes(identity.executable)) { result.push(identity); continue; }
    try {
      const file = await executableFile(identity.executable);
      if (inventory.executableFiles.some((expected) => sameFile(expected, file))) result.push(identity);
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  return result;
};
const temporaryRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)), '.tmp');
const privateRoot = join(temporaryRoot, 'acceptance-private');
export const browserTemporaryRoot = (directory: string): string => {
  const parts = relative(join(temporaryRoot, 'acceptance'), directory).split(sep);
  if (resolve(directory) !== directory || !/^\d{14}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(parts[0]!)
    || !['native/functional', 'native/capacity', 'native/auth-combined', 'container', 'container/auth-combined'].includes(parts.slice(1).join('/'))) {
    throw new Error('Browser phase is outside an owned acceptance run.');
  }
  return join(privateRoot, ...parts, 'browser');
};
const profiles = async (directory: string): Promise<string[]> => {
  const root = browserTemporaryRoot(directory);
  try { return (await readdir(root)).filter((entry) => entry.startsWith('playwright_chromiumdev_profile-')).map((entry) => join(root, entry)); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
};

export const browserProfile = (arguments_: readonly string[] | null, directory: string, workingDirectory = process.cwd()): string => {
  const root = browserTemporaryRoot(directory);
  let values = arguments_?.length === 1 ? [] : arguments_?.filter((argument) => argument.startsWith('--user-data-dir='))
    .map((argument) => argument.slice('--user-data-dir='.length)) ?? [];
  if (arguments_?.length === 1) {
    const title = arguments_[0]!;
    // Chromium can replace its argv with a process title. Its lost argument boundaries
    // are safe to read only for an unquoted Playwright-generated profile name.
    const markers = [...title.matchAll(/--user-data-dir(?==| |$)/g)];
    const switchesOnly = /^[^\s"'`\\]+(?: --[a-zA-Z0-9][a-zA-Z0-9-]*(?:=[^\s"'`\\]+)?)+$/.test(title);
    const match = / --user-data-dir=([^ ]+) (?=--)/.exec(title);
    if (!switchesOnly || markers.length !== 1 || match === null
      || !/^playwright_chromiumdev_profile-[a-zA-Z0-9]{6}$/.test(basename(match[1]!))) {
      throw new Error('Chromium profile identity is missing or ambiguous.');
    }
    values = [match[1]!];
  }
  if (values.length !== 1) throw new Error('Chromium profile identity is missing or ambiguous.');
  const profile = resolve(workingDirectory, values[0]!);
  if (dirname(profile) !== root || !profile.startsWith(join(root, 'playwright_chromiumdev_profile-'))) throw new Error('Chromium profile is outside the owned temporary directory.');
  return profile;
};

const selectedBrowserInventory = (value: unknown): BrowserInventory => {
  const inventory = value as Partial<BrowserInventory> | null | undefined;
  if (inventory === null || inventory === undefined || !Array.isArray(inventory.executables) || inventory.executables.length === 0
    || inventory.executables.some((path) => typeof path !== 'string' || !path.startsWith('/'))
    || !Array.isArray(inventory.profilesBefore) || inventory.profilesBefore.some((path) => typeof path !== 'string' || !path.startsWith('/'))
    || process.platform === 'darwin' && (!Array.isArray(inventory.executableFiles) || inventory.executableFiles.length === 0)
    || inventory.executableFiles !== undefined && (!Array.isArray(inventory.executableFiles) || inventory.executableFiles.some((file) =>
      typeof file !== 'object' || file === null || !inventory.executables!.includes(file.executable)
      || typeof file.device !== 'string' || !/^\d+$/.test(file.device) || typeof file.inode !== 'string' || !/^[1-9]\d*$/.test(file.inode)))) {
    throw new Error('Invalid prelaunch browser inventory for ownership recording.');
  }
  return inventory as BrowserInventory;
};

export const readBrowserInventory = async (directory: string): Promise<BrowserInventory> => {
  const target: unknown = JSON.parse(await readFile(join(directory, 'target.json'), 'utf8'));
  return selectedBrowserInventory(typeof target === 'object' && target !== null && 'browserInventory' in target ? target.browserInventory : undefined);
};

export const recordBrowserOwnership = async (browser: Browser, directory: string, selectedInventory: BrowserInventory): Promise<BrowserOwnership> => {
  selectedBrowserInventory(selectedInventory);
  const session = await browser.newBrowserCDPSession();
  const processes = await session.send('SystemInfo.getProcessInfo');
  await session.detach();
  const browserPid = processes.processInfo.find((process) => process.type === 'browser')?.id;
  if (browserPid === undefined) throw new Error('Chromium did not expose its operating-system process identity.');
  const identity = await processIdentity(browserPid);
  if (identity === null || identity.group !== identity.pid) throw new Error('Chromium browser group identity is not isolated.');
  const inventory: BrowserInventory = process.platform === 'darwin'
    ? selectedInventory
    : { executables: await browserExecutables(identity.executable), profilesBefore: [] };
  let file: BrowserExecutableFile | undefined;
  if (process.platform === 'darwin') {
    const actual = await executableFile(identity.executable);
    file = inventory.executableFiles!.find((expected) => sameFile(expected, actual));
    if (file === undefined || !inventoriedFile(file, inventory)) throw new Error('Chromium executable file differs from the selected browser inventory.');
    file = { ...file };
  }
  const profile = browserProfile(await processArguments(identity.pid), directory);
  if (!await sameBrowserProcess(identity, await processIdentity(identity.pid), file)) throw new Error('Chromium identity changed before ownership recording.');
  const companions = (await ownedBrowserProcesses(directory, inventory.executables)).filter((process) => process.group !== identity.group);
  const owner: BrowserOwnership = { directory, identity, profile, companions, ...(file === undefined ? {} : { executableFile: file }) };
  await writeFile(join(profile, 'daynight-acceptance-owner.json'), `${JSON.stringify(owner)}\n`);
  await mkdir(join(directory, 'browser-processes'), { recursive: true });
  await writeFile(join(directory, 'browser-processes', `${identity.pid}-${identity.startTicks}.json`), `${JSON.stringify(owner)}\n`);
  return owner;
};

export const browserExecutables = async (executable: string): Promise<string[]> => {
  const main = await realpath(executable);
  const result = [main];
  const include = async (candidate: string, bundle?: string): Promise<void> => {
    try {
      const path = await realpath(candidate);
      if (bundle !== undefined && !path.startsWith(`${bundle}/`)) throw new Error('Chromium helper executable escaped its browser bundle.');
      await access(path, constants.X_OK);
      result.push(path);
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  };
  const contents = dirname(dirname(main));
  const bundle = dirname(contents);
  if (basename(dirname(main)) === 'MacOS' && basename(contents) === 'Contents' && bundle.endsWith('.app')) {
    const name = basename(main);
    const versions = join(contents, 'Frameworks', `${name} Framework.framework`, 'Versions');
    for (const version of await readdir(versions, { withFileTypes: true })) {
      if (!version.isDirectory()) continue;
      const helpers = join(versions, version.name, 'Helpers');
      await include(join(helpers, 'chrome_crashpad_handler'), bundle);
      for (const helper of await readdir(helpers, { withFileTypes: true })) {
        const helperName = helper.name.slice(0, -'.app'.length);
        if (!helper.isDirectory() || !helper.name.endsWith('.app')
          || !(helperName === `${name} Helper` || (helperName.startsWith(`${name} Helper (`) && helperName.endsWith(')')))) continue;
        await include(join(helpers, helper.name, 'Contents/MacOS', helperName), bundle);
      }
    }
  } else await include(join(dirname(main), 'chrome_crashpad_handler'));
  return [...new Set(result)];
};

export const browserInventory = async (directory: string): Promise<BrowserInventory> => {
  await mkdir(browserTemporaryRoot(directory), { recursive: true });
  const testRequire = createRequire(import.meta.resolve('@playwright/test'));
  const playwrightRequire = createRequire(testRequire.resolve('playwright'));
  const registry = (playwrightRequire('playwright-core/lib/coreBundle') as {
    registry: { registry: { findExecutable(name: string): { executablePath(): string } } };
  }).registry.registry;
  const executablePaths = process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined
    ? [registry.findExecutable('chromium').executablePath()]
    : [process.env.DAYNIGHT_BROWSER_EXECUTABLE];
  const executables = (await Promise.all(executablePaths.map(browserExecutables))).flat();
  // Chromium's macOS code-sign clone hard-links the main executable. Inventory
  // its file identity; helper paths retain their exact-path contract.
  // https://chromium.googlesource.com/chromium/src/+/6b163abaa66e80f1ebdb990fa070a6bd40fe598e/chrome/browser/mac/code_sign_clone_manager.h
  const executableFiles = process.platform === 'darwin' ? await Promise.all(executablePaths.map(async (path) => executableFile(await realpath(path)))) : undefined;
  return { executables: [...new Set(executables)], profilesBefore: await profiles(directory), ...(executableFiles === undefined ? {} : { executableFiles }) };
};

const sameOwnership = (expected: BrowserOwnership, observed: BrowserOwnership): boolean =>
  expected.directory === observed.directory && expected.profile === observed.profile && sameProcess(expected.identity, observed.identity)
  && sameFileRecord(expected.executableFile, observed.executableFile)
  && Array.isArray(observed.companions) && expected.companions.length === observed.companions.length
  && expected.companions.every((identity) => observed.companions.some((other) => sameProcess(identity, other)));

const stopCompanion = async (identity: ProcessIdentity, directory: string, executables: string[]): Promise<void> => {
  const current = await processIdentity(identity.pid);
  if (current === null || current.startTicks !== identity.startTicks) return;
  if (!sameProcess(identity, current)) throw new Error('Chromium companion identity changed during recovery.');
  if (!(await ownedBrowserProcesses(directory, executables)).some((process) => sameProcess(identity, process))) throw new Error('Chromium companion lost its run ownership marker.');
  if (!sameProcess(identity, await processIdentity(identity.pid))) throw new Error('Chromium companion changed before recovery signal.');
  // Crashpad creates its own process group on macOS. Its receipt authorizes this PID only.
  process.kill(identity.pid, 'SIGTERM');
  let deadline = Date.now() + 10_000;
  while (sameProcess(identity, await processIdentity(identity.pid)) && Date.now() < deadline) await pause();
  if (sameProcess(identity, await processIdentity(identity.pid))) {
    process.kill(identity.pid, 'SIGKILL');
    deadline = Date.now() + 5_000;
    while (sameProcess(identity, await processIdentity(identity.pid)) && Date.now() < deadline) await pause();
  }
  const remaining = await processIdentity(identity.pid);
  if (remaining !== null && remaining.startTicks === identity.startTicks) throw new Error('Chromium companion remains after recovery.');
};

const pause = async (): Promise<void> => { await new Promise((done) => setTimeout(done, 100)); };

export const recoverBrowsers = async (directory: string, inventory: BrowserInventory): Promise<void> => {
  const root = browserTemporaryRoot(directory);
  if (!Array.isArray(inventory.executables) || inventory.executables.length === 0
    || inventory.executables.some((path) => typeof path !== 'string' || !path.startsWith('/'))
    || !Array.isArray(inventory.profilesBefore)
    || inventory.executableFiles !== undefined && (!Array.isArray(inventory.executableFiles) || inventory.executableFiles.some((file) =>
      typeof file !== 'object' || file === null || !inventory.executables.includes(file.executable) || !/^\d+$/.test(file.device) || !/^[1-9]\d*$/.test(file.inode)))) throw new Error('Invalid browser inventory for recovery.');
  const records: BrowserOwnership[] = [];
  try {
    for (const name of await readdir(join(directory, 'browser-processes'))) {
      if (!/^\d+-\d+\.json$/.test(name)) throw new Error('Invalid browser process receipt.');
      records.push(JSON.parse(await readFile(join(directory, 'browser-processes', name), 'utf8')) as BrowserOwnership);
    }
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const observed = await observedBrowsers(directory, inventory);
  const groups = new Set(records.map((record) => record.identity.group));
  const companions = records.flatMap((record) => Array.isArray(record.companions) ? record.companions : []);
  if (observed.some((process) => !groups.has(process.group) && !companions.some((identity) => sameProcess(identity, process)))) throw new Error('Unrecorded Chromium startup process remains; recovery ownership is uncertain.');
  for (const record of records) {
    const identity = record.identity;
    if (record.directory !== directory || identity.platform !== process.platform || identity.group !== identity.pid || !Number.isSafeInteger(identity.pid) || identity.pid <= 1
      || !Array.isArray(record.companions) || record.companions.some((companion) => companion.platform !== process.platform
        || !Number.isSafeInteger(companion.pid) || companion.pid <= 1 || !Number.isSafeInteger(companion.group) || companion.group <= 0
        || companion.group === identity.group || !inventory.executables.includes(companion.executable) || !/^\d+$/.test(companion.startTicks))
      || (record.executableFile === undefined ? !inventory.executables.includes(identity.executable) : !inventoriedFile(record.executableFile, inventory)) || !/^\d+$/.test(identity.startTicks)
      || dirname(record.profile) !== root || !record.profile.startsWith(join(root, 'playwright_chromiumdev_profile-'))) {
      throw new Error('Browser recovery receipt ownership differs from this run.');
    }
    let marker: BrowserOwnership | undefined;
    try { marker = JSON.parse(await readFile(join(record.profile, 'daynight-acceptance-owner.json'), 'utf8')) as BrowserOwnership; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    const active = await processIdentity(identity.pid);
    const members = observed.filter((process) => process.group === identity.group);
    const sameLeader = await sameBrowserProcess(identity, active, record.executableFile);
    if (active !== null && active.startTicks === identity.startTicks && !sameLeader) throw new Error('Browser executable changed during recovery.');
    // The recorded leader stays owned even if Chromium has replaced its launch environment.
    if (members.length > 0 || sameLeader) {
      if (marker === undefined || !sameOwnership(record, marker)) throw new Error('Active browser profile lacks its ownership marker.');
      // A live leader is required before signaling its detached group; orphan-only groups remain uncertain.
      if (!sameLeader) throw new Error('Browser group leader is absent; refusing uncertain group recovery.');
      const membersNow = await observedBrowsers(directory, inventory);
      for (const member of members) {
        if (!await sameBrowserProcess(member, membersNow.find((current) => current.pid === member.pid) ?? null,
          member.pid === identity.pid ? record.executableFile : undefined)) throw new Error('Browser process identities changed during recovery.');
      }
      if (!await sameBrowserProcess(identity, await processIdentity(identity.pid), record.executableFile)) throw new Error('Browser group leader changed before recovery signal.');
      process.kill(-identity.group, 'SIGTERM');
      let deadline = Date.now() + 10_000;
      while (Date.now() < deadline && ((await observedBrowsers(directory, inventory)).some((process) => process.group === identity.group)
        || !isGroupStopped(identity.group))) await pause();
      const remaining = (await observedBrowsers(directory, inventory)).filter((process) => process.group === identity.group);
      if (remaining.length > 0) {
        for (const process of remaining) {
          if (!await sameBrowserProcess(process, await processIdentity(process.pid), process.pid === identity.pid ? record.executableFile : undefined)) throw new Error('Chromium process changed before forced recovery.');
          globalThis.process.kill(process.pid, 'SIGKILL');
        }
        deadline = Date.now() + 5_000;
        while (Date.now() < deadline && ((await observedBrowsers(directory, inventory)).some((process) => process.group === identity.group)
          || !isGroupStopped(identity.group))) await pause();
      }
    }
    for (const companion of record.companions) {
      const activeCompanion = await processIdentity(companion.pid);
      if (activeCompanion !== null && activeCompanion.startTicks === companion.startTicks
        && (marker === undefined || !sameOwnership(record, marker))) throw new Error('Chromium companion lacks its profile ownership marker.');
      await stopCompanion(companion, directory, inventory.executables);
    }
    requireGroupStopped(identity.group);
    if (marker !== undefined) {
      if (!sameOwnership(record, marker)) throw new Error('Browser profile marker changed before cleanup.');
      await rm(record.profile, { recursive: true, force: true });
    }
  }
  if ((await observedBrowsers(directory, inventory)).length > 0) throw new Error('Owned Chromium processes remain after recovery.');
  const known = new Set(records.map((record) => record.profile));
  if ((await profiles(directory)).some((profile) => !inventory.profilesBefore.includes(profile) && !known.has(profile))) {
    throw new Error('Unrecorded Chromium profile remains from a startup window; recovery ownership is uncertain.');
  }
  for (const profile of known) {
    if ((await profiles(directory)).includes(profile)) throw new Error('Owned Chromium profile remains after recovery.');
  }
  for (let path = root; path !== privateRoot; path = dirname(path)) {
    try { await rmdir(path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY') break;
      if (code !== 'ENOENT') throw error;
    }
  }
};
