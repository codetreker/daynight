import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { command } from '../scripts/acceptance/process.mts';
import { findProcesses, isGroupStopped, processIdentity, sameProcess, type ProcessIdentity } from '../scripts/acceptance/identity.mts';

// A child deadline bounds synchronous SDK work without trapping the test runner.
const probe = String.raw`
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { processIdentity } from './scripts/acceptance/identity.mts';
const vite = await createServer({ configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
let server;
try {
  await vite.listen();
  const address = vite.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
  const launch = chromium.launchServer({ channel: 'chromium', headless: true,
    env: { ...process.env, DAYNIGHT_BLOCK_BROWSER_OWNER: process.argv[2] } });
  if (process.argv[1] === 'early') {
    void launch.catch(() => {});
    await new Promise(() => {});
  }
  server = await launch;
  const identity = await processIdentity(server.process().pid);
  if (!identity || identity.group !== identity.pid) throw new Error('Browser group identity is not isolated');
  console.log('BROWSER_IDENTITY=' + JSON.stringify(identity));
  const browser = await chromium.connect(server.wsEndpoint());
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + address.port + '/');
  const result = await page.evaluate(async () => {
    const { renderMermaidDiagram } = await import('/src/features/task-detail/MermaidRenderer.ts');
    const branch = (prefix, depth) => Array.from({ length: depth - 1 }, (_, i) => 'block:' + prefix + i).join('\n')
      + '\n' + prefix + 'leaf["' + prefix + 'label"]\n' + Array.from({ length: depth - 1 }, () => 'end').join('\n');
    const deep = 'block\n' + branch('D', 27);
    try { await renderMermaidDiagram(deep, new AbortController().signal); throw new Error('Deep layout was accepted'); }
    catch (error) {
      if (error.issue !== 'complexity' || error.cause?.issue !== 'complexity') throw error;
    }
    // 49,999 calls including root: two deep branches plus 425 leaf blocks.
    const leaves = Array.from({ length: 425 }, (_, i) => 'L' + i + '["Leaf ' + i + '"]').join('\n');
    const normal = 'block\n' + branch('A', 14) + '\n' + branch('B', 13) + '\n' + leaves;
    const svg = await renderMermaidDiagram(normal, new AbortController().signal);
    const xml = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const text = xml.documentElement.textContent ?? '';
    return { viewBox: xml.documentElement.getAttribute('viewBox'), labels: ['Alabel', 'Blabel', 'Leaf 424'].every((label) => text.includes(label)) };
  });
  if (!result.viewBox || !result.labels) throw new Error('Following Block did not render its real labels and size');
  await browser.close();
} finally {
  try { if (server) await server.close(); }
  finally { await vite.close(); }
}
console.log('PROBE_CLEANUP_COMPLETE');
`;

const runProbe = async (mode: 'normal' | 'early'): Promise<void> => {
  const marker = randomUUID();
  const tempRoot = resolve(process.cwd(), '.tmp');
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, 'block-browser-'));
  const environment = { DAYNIGHT_BLOCK_BROWSER_OWNER: marker };
  const groups = new Set<number>();
  let output = '';
  let identity: ProcessIdentity | undefined;
  let monitorError: unknown;
  let scan = Promise.resolve();
  const observe = async (): Promise<ProcessIdentity[]> => {
    const processes = await findProcesses(environment);
    for (const process of processes) groups.add(process.group);
    return processes;
  };
  const watch = setInterval(() => {
    scan = scan.then(async () => { await observe(); }).catch((error: unknown) => { monitorError ??= error; });
  }, 100);
  const terminateOwned = async (): Promise<void> => {
    const first = await observe();
    for (const group of new Set(first.map((process) => process.group))) {
      const verified = await observe();
      const member = first.find((process) => process.group === group && verified.some((current) => sameProcess(process, current)));
      if (member === undefined || !sameProcess(member, await processIdentity(member.pid))) {
        if (isGroupStopped(group)) continue;
        throw new Error('Browser group ownership could not be verified.');
      }
      try { process.kill(-group, 'SIGKILL'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
    }
  };
  let forced: Promise<void> | undefined;
  let forcedError: unknown;
  const deadline = setTimeout(() => { forced = terminateOwned().catch((error: unknown) => { forcedError = error; }); }, mode === 'early' ? 3_000 : 25_000);
  let failed: unknown;
  try {
    await command(process.execPath, ['--input-type=module', '-e', probe, mode, marker], {
      cwd: process.cwd(), quiet: true, timeoutMs: mode === 'early' ? 6_000 : 30_000,
      env: { ...process.env, TMPDIR: directory },
      onOutput: (chunk) => {
        output += chunk;
        const match = /(?:^|\n)BROWSER_IDENTITY=([^\n]+)\n/.exec(output);
        if (match) { identity = JSON.parse(match[1]!) as ProcessIdentity; groups.add(identity.group); }
      },
    });
    if (mode === 'early') throw new Error('Early startup probe unexpectedly completed.');
    expect(output).toContain('PROBE_CLEANUP_COMPLETE');
  } catch (error) { failed = error; }
  finally {
    clearTimeout(deadline);
    clearInterval(watch);
    await scan;
    if (forced !== undefined) await forced;
    await terminateOwned();
    // If the marker or leader disappears while a group remains, refuse to
    // signal unverified processes and report the incomplete cleanup.
    const until = Date.now() + 5_000;
    while (Date.now() < until && [...groups].some((group) => !isGroupStopped(group))) await new Promise((done) => setTimeout(done, 100));
    if ([...groups].some((group) => !isGroupStopped(group)) || (await observe()).length > 0) throw new Error('Owned browser groups did not stop; cleanup is incomplete.');
    if (monitorError !== undefined) throw monitorError;
    if (forcedError !== undefined) throw forcedError;
    if (mode === 'early' && groups.size === 0) throw new Error('Early startup browser was not observed.');
    await rm(directory, { recursive: true, force: true });
  }
  if (mode === 'early') expect(String(failed)).toContain('timed out');
  else if (failed !== undefined) throw failed;
};

describe('Block layout work limit in Chromium', () => {
  it('refuses deep layout and renders the next valid diagram', async () => { await runProbe('normal'); }, 40_000);
  it('cleans a browser stalled before launch returns', async () => { await runProbe('early'); }, 20_000);
});
