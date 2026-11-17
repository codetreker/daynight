import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { browserCommandOptions } from '../src/browser.ts';
import { CommandFailure, runCommand } from '../src/command.ts';

const root = path.resolve(import.meta.dirname, '../../..', '.tmp');

test('browser descendants resolve a short temporary path independently within each private run', async () => {
  await mkdir(root, { recursive: true });
  const runs = await Promise.all([mkdtemp(path.join(root, 'e2e-browser-')), mkdtemp(path.join(root, 'e2e-browser-'))]);
  try {
    await Promise.all(runs.map(run => mkdir(path.join(run, 'private'))));
    const script = `const {spawnSync}=require('node:child_process');
      const child=spawnSync(process.execPath,['-e',"const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const p=fs.mkdtempSync(path.join(os.tmpdir(),'browser-'));process.stdout.write(JSON.stringify({cwd:fs.realpathSync('.'),directory:fs.realpathSync(p),temporary:os.tmpdir()}));"],{encoding:'utf8'});
      if(child.status!==0)throw new Error(child.stderr);process.stdout.write(child.stdout);`;
    const results = await Promise.all(runs.map(run => runCommand(process.execPath, ['-e', script], { ...browserCommandOptions(run), timeoutMs: 5_000, onOutput: () => {} })));
    for (let index = 0; index < runs.length; index++) {
      const value = JSON.parse(results[index]!.stdout) as { cwd: string; directory: string; temporary: string };
      const privateDirectory = await realpath(path.join(runs[index]!, 'private'));
      assert.equal(value.temporary, '/proc/self/cwd');
      assert.equal(value.cwd, privateDirectory);
      assert.equal(path.dirname(value.directory), privateDirectory);
    }
  } finally { await Promise.all(runs.map(run => rm(run, { recursive: true, force: true }))); }
});

test('browser failures retain diagnostics while private data remains owned by the run', async () => {
  await mkdir(root, { recursive: true });
  const run = await mkdtemp(path.join(root, 'e2e-browser-'));
  try {
    await mkdir(path.join(run, 'private'));
    await assert.rejects(runCommand(process.execPath, ['-e', "require('node:fs').mkdtempSync('/proc/self/cwd/browser-');process.stderr.write('browser failed');process.exit(7)"], { ...browserCommandOptions(run), timeoutMs: 5_000, onOutput: () => {} }), (error: unknown) => error instanceof CommandFailure && error.result.stderr === 'browser failed');
  } finally { await rm(run, { recursive: true, force: true }); }
});
