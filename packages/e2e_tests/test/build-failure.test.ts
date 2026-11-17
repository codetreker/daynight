import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const repository = path.resolve(import.meta.dirname, '../../..');
const fixture = async () => {
  const root = path.join(repository, '.tmp', `e2e-build-test-${randomUUID()}`);
  const source = path.join(root, 'packages', 'e2e_tests', 'src'), bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await mkdir(path.dirname(source), { recursive: true });
  await cp(path.join(repository, 'packages', 'e2e_tests', 'src'), source, { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(bin, 'git'), '#!/bin/sh\nif [ "$1" = rev-parse ]; then echo fixture-revision; fi\n');
  await chmod(path.join(bin, 'git'), 0o700);
  const pointer = path.join(root, '.tmp', 'pointer.json'), lock = path.join(root, '.tmp', 'product-e2e-build-lock');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, DAYNIGHT_E2E_RUN_POINTER: pointer };
  return { root, bin, source, pointer, lock, env };
};
const runner = (source: string) => path.join(source, 'run.ts');
const cleanup = (source: string) => path.join(source, 'ci-cleanup.ts');
const setPnpm = async (bin: string, script: string) => { const name = path.join(bin, 'pnpm'); await writeFile(name, `#!/bin/sh\n${script}\n`); await chmod(name, 0o700); };

test('ordinary failed build releases its lock and preserves failure for a later run', async () => {
  const f = await fixture();
  try {
    await setPnpm(f.bin, 'echo intentional-build-error >&2; exit 7');
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(() => execFileSync(process.execPath, [runner(f.source)], { cwd: f.root, env: f.env, timeout: 20_000, stdio: 'pipe' }), (error: unknown) => {
        const failure = error as { status: number; stderr: Buffer };
        assert.equal(failure.status, 1); assert.match(failure.stderr.toString(), /intentional-build-error/); return true;
      });
      const { runDirectory } = JSON.parse(await readFile(f.pointer, 'utf8')) as { runDirectory: string };
      assert.equal(JSON.parse(await readFile(path.join(runDirectory, 'results', 'build-complete.json'), 'utf8')).complete, true);
      assert.equal(JSON.parse(await readFile(path.join(runDirectory, 'results', 'manifest.json'), 'utf8')).status, 'failed');
      await assert.rejects(stat(f.lock), { code: 'ENOENT' });
      execFileSync(process.execPath, [cleanup(f.source)], { cwd: f.root, env: f.env, timeout: 20_000 });
      await assert.rejects(stat(f.pointer), { code: 'ENOENT' });
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('cancelled build retains its original lock and cannot be recovered as settled', async () => {
  const f = await fixture(), marker = path.join(f.root, 'build-started');
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await setPnpm(f.bin, `echo started > '${marker}'; exec sleep 60`);
    child = spawn(process.execPath, [runner(f.source)], { cwd: f.root, env: f.env, stdio: 'ignore' });
    const deadline = Date.now() + 10_000;
    while (true) { try { await stat(marker); break; } catch { if (Date.now() > deadline) throw new Error('Build did not start.'); await new Promise(resolve => setTimeout(resolve, 20)); } }
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    const { runDirectory } = JSON.parse(await readFile(f.pointer, 'utf8')) as { runDirectory: string };
    await assert.rejects(stat(path.join(runDirectory, 'results', 'build-complete.json')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(f.lock, 'utf8')).runDirectory, runDirectory);
    assert.throws(() => execFileSync(process.execPath, [cleanup(f.source)], { cwd: f.root, env: f.env, timeout: 20_000, stdio: 'pipe' }));
    assert.equal(JSON.parse(await readFile(f.lock, 'utf8')).runDirectory, runDirectory);
    assert.equal((await stat(path.join(runDirectory, 'private'))).isDirectory(), true);
  } finally { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } await rm(f.root, { recursive: true, force: true }); }
});

test('a runner denied the build lock does not release another run’s lock', async () => {
  const f = await fixture();
  try {
    await mkdir(path.dirname(f.lock), { recursive: true });
    const original = JSON.stringify({ schemaVersion: 1, runDirectory: '/another/run' });
    await writeFile(f.lock, original);
    assert.throws(() => execFileSync(process.execPath, [runner(f.source)], { cwd: f.root, env: f.env, timeout: 20_000, stdio: 'pipe' }));
    assert.equal(await readFile(f.lock, 'utf8'), original);
    assert.throws(() => execFileSync(process.execPath, [cleanup(f.source)], { cwd: f.root, env: f.env, timeout: 20_000, stdio: 'pipe' }));
    assert.equal(await readFile(f.lock, 'utf8'), original);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
