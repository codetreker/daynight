import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { startCommand, assertCommandQuiescence } from './command.ts';
import { fallbackBaseline, fallbackPatchSHA256 } from './subtask-compat-recovery-provenance.ts';

const repository = path.resolve(import.meta.dirname, '../../..');
const patch = path.join(import.meta.dirname, 'subtask-compat-fallback.patch');
if (createHash('sha256').update(await readFile(patch)).digest('hex') !== fallbackPatchSHA256) throw new Error('Fallback patch digest mismatch.');
const run = async (name: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<void> => {
  const child = startCommand(name, args, { cwd, timeoutMs, onOutput: (channel, chunk) => (channel === 'stdout' ? process.stdout : process.stderr).write(chunk) });
  if ((await child.finished).exitCode !== 0) throw new Error(`Fallback validation failed: ${path.basename(name)}.`);
};
const scratch = path.join(repository, '.tmp'); await mkdir(scratch, { recursive: true, mode: 0o700 });
const temporary = await mkdtemp(path.join(scratch, 'fallback-cache-validation-'));
try {
  const source = path.join(temporary, 'source');
  await run('git', ['clone', '--no-hardlinks', '--no-checkout', repository, source], repository);
  await run('git', ['checkout', '--detach', fallbackBaseline], source);
  await run('git', ['apply', '--unidiff-zero', '--check', patch], source); await run('git', ['apply', '--unidiff-zero', patch], source);
  const web = path.join(source, 'packages/daynight-web');
  await symlink(path.join(repository, 'node_modules'), path.join(source, 'node_modules'), 'dir');
  await symlink(path.join(repository, 'packages/daynight-web/node_modules'), path.join(web, 'node_modules'), 'dir');
  for (const [fixture, destination] of [['fallback-cache-engine.test.ts.txt', 'fallback-cache-engine.test.ts'], ['fallback-cache-graph.test.tsx.txt', 'fallback-cache-graph.test.tsx'], ['fallback-thread.test.tsx.txt', 'fallback-thread.test.tsx'], ['fallback-access.test.ts.txt', 'fallback-access.test.ts']]) {
    await cp(path.join(repository, 'packages/e2e_tests/validation', fixture!), path.join(web, 'tests', destination!), { errorOnExist: true, force: false });
  }
  await run(path.join(repository, 'packages/daynight-web/node_modules/.bin/vitest'), ['run', 'tests/fallback-cache-engine.test.ts', 'tests/fallback-cache-graph.test.tsx', 'tests/fallback-thread.test.tsx', 'tests/fallback-access.test.ts'], web);
} finally { assertCommandQuiescence(); await rm(temporary, { recursive: true, force: true }); }
