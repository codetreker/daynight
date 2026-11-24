import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

const scripts = dirname(fileURLToPath(import.meta.url));
const routes = [
  ['internal/core/store/postgres/task', 'DAYNIGHT_TEST_POSTGRES_TASK_URL'],
  ['internal/core/store/postgres/github', 'DAYNIGHT_TEST_POSTGRES_GITHUB_URL'],
  ['internal/core/store/postgres/identity', 'DAYNIGHT_TEST_POSTGRES_IDENTITY_URL'],
  ['internal/core/store/postgres/session', 'DAYNIGHT_TEST_POSTGRES_SESSION_URL'],
  ['internal/core/store/postgres/worker', 'DAYNIGHT_TEST_POSTGRES_WORKER_URL'],
  ['internal/service/project', 'DAYNIGHT_TEST_SERVICE_PROJECT_URL'],
  ['internal/service/session', 'DAYNIGHT_TEST_SERVICE_SESSION_URL'],
  ['internal/service/mcpdownload', 'DAYNIGHT_TEST_SERVICE_MCPDOWNLOAD_URL'],
] as const;

async function fixture(t: TestContext) {
  const temporary = resolve(scripts, '../.tmp');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'database routing '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  const launcher = join(root, 'scripts/go-test-database-exec.sh');
  await copyFile(join(scripts, 'go-test-database-exec.sh'), launcher);
  await chmod(launcher, 0o755);
  for (const [directory] of routes) await mkdir(join(root, directory), { recursive: true });
  for (const directory of ['internal/core/store/postgres', 'internal/core/store/postgres/task/sub', 'internal/service/projects']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  const env = { ...process.env, DAYNIGHT_TEST_DATABASE_URL: 'shared',
    DAYNIGHT_TEST_STORE_ROOT_DATABASE_URL: 'root', GOFLAGS: '-tags=original',
    ...Object.fromEntries(routes.map(([, variable], index) => [variable, `database-${index}`])) };
  return { root, launcher, env };
}

test('exact package directories select their own database and preserve argv and environment', async t => {
  const { root, launcher, env } = await fixture(t);
  const probe = 'process.stdout.write(JSON.stringify({args:process.argv.slice(1),url:process.env.DAYNIGHT_TEST_DATABASE_URL,root:process.env.DAYNIGHT_TEST_STORE_ROOT_DATABASE_URL,flags:process.env.GOFLAGS}));';
  for (const [directory, variable] of routes) {
    const result = spawnSync(launcher, [process.execPath, '-e', probe, 'argument with spaces', '--literal'], {
      cwd: join(root, directory), env, encoding: 'utf8', timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args: ['argument with spaces', '--literal'],
      url: env[variable], root: 'root', flags: '-tags=original' });
  }
  for (const directory of ['internal/core/store/postgres', 'internal/core/store/postgres/task/sub', 'internal/service/projects']) {
    const result = spawnSync(launcher, [process.execPath, '-e', probe], { cwd: join(root, directory), env, encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args: [], url: 'shared', root: 'root', flags: '-tags=original' });
  }
});

test('a missing selected URL fails before launch and exit status and signals pass through', async t => {
  const { root, launcher, env } = await fixture(t);
  const cwd = join(root, routes[0][0]);
  const missing = spawnSync(launcher, [process.execPath, '-e', 'process.stdout.write("unexpected")'], {
    cwd, env: { ...env, [routes[0][1]]: '' }, encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(missing.error);
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /Missing DAYNIGHT_TEST_POSTGRES_TASK_URL/);
  const failed = spawnSync(launcher, [process.execPath, '-e', 'process.exit(37)'], { cwd, env, timeout: 5000 });
  assert.ifError(failed.error);
  assert.equal(failed.status, 37);
  const signaled = spawnSync(launcher, [process.execPath, '-e', 'process.kill(process.pid,"SIGTERM")'], { cwd, env, timeout: 5000 });
  assert.ifError(signaled.error);
  assert.equal(signaled.signal, 'SIGTERM');
});

test('Go runs the launcher in the package directory with its real test arguments', { timeout: 120_000 }, async t => {
  const { root, launcher, env } = await fixture(t);
  await writeFile(join(root, 'go.mod'), 'module example.test/launcher\n\ngo 1.21\n');
  await writeFile(join(root, routes[0][0], 'routing_test.go'), `package task
import ("flag"; "os"; "os/exec"; "strings"; "testing")
var value = flag.String("probe", "", "")
func TestRouting(t *testing.T) {
  cwd, err := os.Getwd(); if err != nil { t.Fatal(err) }
  if !strings.HasSuffix(cwd, "/internal/core/store/postgres/task") { t.Fatalf("cwd: %s", cwd) }
  if os.Getenv("DAYNIGHT_TEST_DATABASE_URL") != "database-0" || *value != "hello world" { t.Fatalf("database/arg: %s %s", os.Getenv("DAYNIGHT_TEST_DATABASE_URL"), *value) }
  out, err := exec.Command("go", "env", "GOFLAGS").Output(); if err != nil { t.Fatal(err) }
  if strings.TrimSpace(string(out)) != "" { t.Fatalf("nested Go inherited flags: %s", out) }
}`);
  const result = spawnSync('go', ['test', `-exec='${launcher}'`, '-count=1', './internal/core/store/postgres/task', '-args', '-probe=hello world'], {
    cwd: root, env: { ...env, GOFLAGS: '' }, encoding: 'utf8', timeout: 110_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
