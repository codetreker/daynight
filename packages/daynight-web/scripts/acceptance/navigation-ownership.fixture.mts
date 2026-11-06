import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordBrowserOwnership, type BrowserInventory } from './browser.mts';
import { processIdentity } from './identity.mts';
import { runCiCommand, runNavigationChecks } from './navigation.mts';
import type { Browser } from '@playwright/test';

const [mode, directory, executable] = process.argv.slice(2);
assert.ok(directory !== undefined && executable !== undefined);

if (mode === 'functional') {
  const inventory = JSON.parse(await readFile(join(directory, 'inventory.json'), 'utf8')) as BrowserInventory;
  const browser = { newBrowserCDPSession: async () => ({
    send: async () => ({ processInfo: [{ type: 'browser', id: process.pid }] }), detach: async () => {},
  }) } as unknown as Browser;
  const owner = await recordBrowserOwnership(browser, directory, inventory);
  process.stdout.write(`${JSON.stringify(owner)}\n`);
  setInterval(() => {}, 1_000);
} else if (mode === 'navigation-browser') {
  const profile = await mkdtemp(join(tmpdir(), 'playwright_chromiumdev_profile-'));
  process.stdout.write(`${JSON.stringify({ identity: await processIdentity(process.pid), profile,
    environment: Object.fromEntries(['DAYNIGHT_ACCEPTANCE_DIRECTORY', 'DAYNIGHT_BROWSER_CHANNEL', 'PATH', 'TMPDIR', 'TMP', 'TEMP']
      .filter(key => Object.hasOwn(process.env, key)).map(key => [key, process.env[key]])) })}\n`);
  setInterval(() => {}, 1_000);
} else {
  assert.equal(mode, 'callback');
  const cancellation = new AbortController(), finished = new Error('Navigation fixture completed.');
  const stop = (): void => cancellation.abort(finished);
  process.once('message', stop);
  process.once('SIGTERM', stop);
  try {
    await assert.rejects(runNavigationChecks(cancellation, async (_file, _args, options) => {
      let output = '';
      return await runCiCommand(executable, [import.meta.filename, 'navigation-browser', directory, executable], {
        ...options, quiet: true, onOutput: chunk => {
          output += chunk;
          if (output.includes('\n')) process.send!(JSON.parse(output.slice(0, output.indexOf('\n'))));
        },
      });
    }), error => error instanceof Error && error.cause === finished);
  } finally {
    process.removeListener('message', stop);
    process.removeListener('SIGTERM', stop);
    process.disconnect();
  }
}
