import { strict as assert } from 'node:assert';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function runCheck(t: import('node:test').TestContext, ci: string | undefined, extra: Record<string, string> = {}, spaceInPath = false) {
  const root = join(moduleRoot, '.tmp');
  await mkdir(root, { recursive: true });
  const fixture = await mkdtemp(join(root, spaceInPath ? 'check fixture-' : 'check-test-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const scripts = join(fixture, 'scripts');
  const bin = join(fixture, 'bin');
  await mkdir(scripts);
  await mkdir(bin);
  await copyFile(join(moduleRoot, 'scripts/check.sh'), join(scripts, 'check.sh'));
  const overlay = await readFile(join(moduleRoot, 'scripts/unit-overlay.json'), 'utf8');
  await writeFile(join(scripts, 'unit-overlay.json'), overlay);
  await writeFile(join(scripts, 'check-child-overlay.mjs'), `
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
const match = process.env.GOFLAGS.match(/"-overlay=([^"]+)"|'-overlay=([^']+)'|(?:^|\\s)-overlay=(\\S+)/);
assert.ok(match, 'coverage child must inherit an overlay');
const path = match[1] ?? match[2] ?? match[3];
assert.equal(readFileSync(path, 'utf8'), process.env.EXPECTED_OVERLAY);
console.log('coverage child read the original overlay from ' + process.cwd());
`);
  await writeFile(join(scripts, 'env.sh'), 'DAYNIGHT_MODULE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"\nexport GOBIN="$DAYNIGHT_MODULE_ROOT/bin"\n');
  const fakeGo = `#!/usr/bin/env bash
set -eu
printf 'go %s GOFLAGS=%s\\n' "$*" "\${GOFLAGS-}" >> "$TRACE"
case "$1" in
  tool)
    if [[ "$2" == covdata ]]; then
      "$REAL_NODE" "$CHILD_OVERLAY_PROBE" >> "$TRACE"
    fi ;;
  list) if [[ -z "\${EMPTY_PACKAGES-}" ]]; then printf '%s\\n' example/api example/server; fi ;;
  install)
    cat > "$GOBIN/go-cov" <<'COV'
#!/usr/bin/env bash
set -eu
printf 'go-cov %s GOFLAGS=%s\\n' "$*" "\${GOFLAGS-}" >> "$TRACE"
cd "$GOBIN"
go tool covdata textfmt
exit "\${COV_EXIT:-0}"
COV
    chmod +x "$GOBIN/go-cov" ;;
esac
`;
  const fakeNode = `#!/usr/bin/env bash
set -eu
printf 'node %s\\n' "$*" >> "$TRACE"
if [[ "$1" == scripts/prepare-uniauth-fixture.mts ]]; then printf '%s\\n' fixture; fi
`;
  await writeFile(join(bin, 'go'), fakeGo);
  await writeFile(join(bin, 'node'), fakeNode);
  await chmod(join(bin, 'go'), 0o755);
  await chmod(join(bin, 'node'), 0o755);
  const trace = join(fixture, 'trace');
  const env = { ...process.env, ...extra, PATH: `${bin}:${process.env.PATH}`, TRACE: trace,
    REAL_NODE: process.execPath, CHILD_OVERLAY_PROBE: join(scripts, 'check-child-overlay.mjs'), EXPECTED_OVERLAY: overlay,
    DAYNIGHT_TEST_DATABASE_URL: 'postgres://fixture', GOFLAGS: '-race', CI: ci };
  const result = spawnSync('bash', [join(scripts, 'check.sh'), '--coverage'], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined);
  return { result, trace: await readFile(trace, 'utf8') };
}

test('module check selects production packages and local race instrumentation', async (t) => {
  const { result, trace } = await runCheck(t, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(trace, /go-cov --race=true GOFLAGS=.*-coverpkg=example\/api,example\/server/);
  assert.match(trace, /node --test scripts\/coverage.test.mts/);
  assert.match(trace, /node scripts\/coverage.mts coverage.out/);
});

test('CI disables inherited race and propagates coverage failure', async (t) => {
  const { result, trace } = await runCheck(t, 'true', { COV_EXIT: '17' });
  assert.equal(result.status, 17);
  assert.match(trace, /go-cov --race=false GOFLAGS=.*-race -p=2 "-overlay=[^\n]+\/scripts\/unit-overlay.json" -race=false -coverpkg=example\/api,example\/server/);
  assert.doesNotMatch(trace, /node scripts\/coverage.mts/);
});

test('coverage metadata child retains the overlay after changing directories', async (t) => {
  const { result, trace } = await runCheck(t, undefined, {}, true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(trace, /go tool covdata textfmt/);
  assert.match(trace, /coverage child read the original overlay from [^\n]+check fixture-[^\n]+\/bin/);
});

test('module check fails when no production packages are listed', async (t) => {
  const { result, trace } = await runCheck(t, 'true', { EMPTY_PACKAGES: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No production packages found/);
  assert.doesNotMatch(trace, /go-cov/);
});
