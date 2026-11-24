import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const modulePath = 'example.com/server';
const store = `${modulePath}/internal/core/store/postgres`;
const targets = [`${store}/identity`, `${store}/task`];
const production = [
  `${modulePath}/internal/service`, store, ...targets, `${store}/team`,
];
const source = '0123456789abcdef0123456789abcdef01234567';

const shardFixture = async (t: TestContext, event: 'pull_request' | 'push', testExit = 0) => {
  const temporary = resolve(scripts, '../.tmp');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'go-shard-runner-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  const copied = join(directory, 'scripts');
  await mkdir(bin);
  await mkdir(copied);
  await Promise.all([
    'check-go-shard.sh', 'command-process-group.mts', 'command-timeout.mts', 'env.sh',
    'go-shard-plan.mts', 'go-test-output.mts', 'unit-overlay.json', 'validation-env.sh',
  ].map(name => copyFile(join(scripts, name), join(copied, name))));

  await writeFile(join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" ' + source + '\n', { mode: 0o755 });
  await writeFile(join(bin, 'go'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('go-commands.jsonl', JSON.stringify({ args, flags: process.env.GOFLAGS }) + '\\n');
if (args[0] === 'list') {
  if (args.includes('-m')) console.log(${JSON.stringify(modulePath)});
  else console.log(${JSON.stringify([
    ...production.map(name => name + ' production'),
    modulePath + '/cmd/daynight-server production',
    store + '/only_test',
  ].join('\n'))});
} else if (args[0] === 'test') {
  const profile = args.find(arg => arg.startsWith('-coverprofile='));
  if (!profile) throw new Error('missing coverage profile');
  fs.writeFileSync(profile.slice('-coverprofile='.length), 'mode: atomic\\n');
  console.log(JSON.stringify({ Action: 'pass', Package: ${JSON.stringify(targets[0])} }));
  process.exitCode = ${testExit};
} else throw new Error('unexpected Go command: ' + args[0]);
`, { mode: 0o755 });
  await writeFile(join(copied, 'go-shard-coverage.mts'), String.raw`
import { copyFileSync } from 'node:fs';
if (process.argv[2] !== 'compact') throw new Error('expected profile compaction');
copyFileSync(process.argv[3]!, process.argv[4]!);
`);

  const result = spawnSync('bash', ['scripts/check-go-shard.sh', 'store-a'], {
    cwd: directory,
    env: {
      ...process.env,
      CI: 'true',
      GITHUB_EVENT_NAME: event,
      GITHUB_REF: event === 'push' ? 'refs/heads/main' : 'refs/pull/42/merge',
      DAYNIGHT_TEST_DATABASE_URL: 'postgres://fixture',
      DAYNIGHT_TEST_REDIS_URL: 'redis://fixture',
      DAYNIGHT_TEST_UNIAUTH_FIXTURE: undefined,
      GOFLAGS: '-race',
      PATH: bin + ':' + process.env.PATH,
    },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ifError(result.error);
  const output = join(directory, '.tmp/go-shard/store-a');
  const invocations = (await readFile(join(directory, 'go-commands.jsonl'), 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as { args: string[]; flags: string });
  return { invocations, output, result };
};

test('a PR shard covers the whole module and executes just its assigned packages', async t => {
  const { invocations, output, result } = await shardFixture(t, 'pull_request');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(invocations.map(({ args }) => args[0]), ['list', 'list', 'test']);
  const { args, flags } = invocations[2]!;
  assert.match(flags, /^-race -p=2 .* -tags= -race=false$/);
  assert.deepEqual(args, [
    'test', '-count=1', '-json', '-covermode=atomic', '-timeout=10m',
    '-coverpkg=' + production.join(','), '-coverprofile=' + join(output, 'coverage.raw'), ...targets,
  ]);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8')), {
    version: 1, shard: 'store-a', source, race: false, packages: targets,
  });
  const rawEvents = await readFile(join(output, 'go-test.jsonl'));
  assert.deepEqual(JSON.parse(await readFile(join(output, 'go-test.complete.json'), 'utf8')), {
    version: 1, bytes: rawEvents.length, exitCode: 0, signal: null,
  });
  assert.equal(await readFile(join(output, 'coverage.out'), 'utf8'), 'mode: atomic\n');
  await assert.rejects(readFile(join(output, 'coverage.raw')), { code: 'ENOENT' });
});

test('a main shard retains race and a failing Go test cannot produce a receipt', async t => {
  const { invocations, output, result } = await shardFixture(t, 'push', 17);
  assert.equal(result.status, 17, result.stderr);
  assert.match(invocations[2]!.flags, / -race=true$/);
  const capture = JSON.parse(await readFile(join(output, 'go-test.complete.json'), 'utf8'));
  assert.equal(capture.exitCode, 17);
  await assert.rejects(readFile(join(output, 'receipt.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(output, 'coverage.out')), { code: 'ENOENT' });
});
