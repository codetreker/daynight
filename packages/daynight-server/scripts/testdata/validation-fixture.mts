import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const runValidation = async (t: TestContext, entry: 'check' | 'startup-shutdown', ci: string | undefined,
  extra: Record<string, string> = {}) => {
  const temporary = join(moduleRoot, '.tmp');
  await mkdir(temporary, { recursive: true });
  const fixture = await mkdtemp(join(temporary, 'validation-test-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const scripts = join(fixture, 'scripts');
  const tools = join(fixture, 'tools');
  await mkdir(scripts);
  await mkdir(tools);
  await mkdir(join(fixture, 'cmd/daynight-server'), { recursive: true });
  for (const file of [`${entry}.sh`, 'env.sh', 'validation-env.sh', 'unit-overlay.json', 'coverage.mts', 'command-timeout.mts']) {
    await copyFile(join(moduleRoot, 'scripts', file), join(scripts, file));
  }
  await copyFile(join(moduleRoot, '.go-cov.toml'), join(fixture, '.go-cov.toml'));
  const fakeGo = `#!/usr/bin/env bash
set -eu
printf 'go %s GOFLAGS=%s CWD=%s\\n' "$*" "\${GOFLAGS-}" "$PWD" >> "$TRACE"
case "$1" in
  list)
    if [[ "$*" == *./cmd/daynight-server* ]]; then printf '%s\\n' example/cmd/daynight-server
    elif [[ -z "\${EMPTY_PACKAGES-}" ]]; then printf '%s\\n' example/api example/cmd/daynight-server example/internal/server
    fi ;;
  build) exit "\${BUILD_EXIT:-0}" ;;
  vet) exit "\${VET_EXIT:-0}" ;;
  test)
    if [[ "$*" == *TestWebhookRunnerAbruptProcessRecovery* ]]; then exit "\${PROCESS_EXIT:-0}"; fi
    if [[ "$*" == *./testdata/testauth* ]]; then exit "\${TESTAUTH_EXIT:-0}"; fi ;;
  install)
    cat > "$GOBIN/go-cov" <<'COV'
#!/usr/bin/env bash
set -eu
printf 'go-cov %s GOFLAGS=%s CWD=%s CONFIG_ENV=%s\\n' "$*" "\${GOFLAGS-}" "$PWD" "\${THRESHOLD_TOTAL-unset},\${EXCLUDE_PACKAGES-unset},\${BUILD_TAGS-unset},\${COVERPROFILE-unset}" >> "$TRACE"
if [[ "\${COV_EXIT:-0}" != 0 ]]; then exit "$COV_EXIT"; fi
profile=coverage.out
for argument in "$@"; do
  if [[ "$argument" == --coverprofile=* ]]; then profile="\${argument#--coverprofile=}"; fi
done
covered=\${PROFILE_COVERED:-10}
total=\${PROFILE_TOTAL:-11}
printf 'mode: atomic\\nexample/server/source.go:1.1,2.1 %s 1\\nexample/server/source.go:3.1,4.1 %s 0\\n' "$covered" "$((total-covered))" > "$profile"
COV
    chmod +x "$GOBIN/go-cov" ;;
esac
`;
  const fakeNode = `#!/usr/bin/env bash
set -eu
printf 'node %s\\n' "$*" >> "$TRACE"
if [[ "$1" == --input-type=module || "$1" == *coverage.mts || "$1" == *command-timeout.mts ]]; then exec ${shellQuote(process.execPath)} "$@"; fi
if [[ "$1" == scripts/prepare-uniauth-fixture.mts ]]; then printf '%s\\n' fixture; fi
`;
  await writeFile(join(tools, 'go'), fakeGo);
  await writeFile(join(tools, 'node'), fakeNode);
  await chmod(join(tools, 'go'), 0o755);
  await chmod(join(tools, 'node'), 0o755);
  const traceFile = join(fixture, 'trace');
  const env = { ...process.env, PATH: `${tools}:${process.env.PATH}`, TRACE: traceFile,
    DAYNIGHT_TEST_DATABASE_URL: 'postgres://fixture', GOFLAGS: '-race', CI: ci,
    GITHUB_EVENT_NAME: undefined, GITHUB_REF: undefined, ...extra };
  const result = spawnSync('bash', [join(scripts, `${entry}.sh`), ...(entry === 'check' ? ['--coverage'] : [])], {
    env, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(result.error);
  return { result, fixture, trace: await readFile(traceFile, 'utf8'),
    overlay: JSON.parse(await readFile(join(fixture, '.tmp/unit-overlay.json'), 'utf8')) as { Replace: Record<string, string> } };
};
