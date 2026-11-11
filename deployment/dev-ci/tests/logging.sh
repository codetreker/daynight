#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_dir="$(cd -- "$script_dir/../../.." && pwd)"
if [[ ${1:-} != --inside ]]; then
  exec bash "$repository_dir/deployment/dev-ci/run.sh" bash "$script_dir/logging.sh" --inside
fi

compose=(docker compose --env-file "$DAYNIGHT_DEV_CI_AUTH_ENV_FILE" \
  --project-directory "$repository_dir/deployment/dev-ci" \
  --file "$repository_dir/deployment/dev-ci/compose.yaml" \
  --project-name "daynight-dev-ci-$DAYNIGHT_DEV_CI_RUN_ID")
scratch="$(mktemp -d "$repository_dir/.tmp/dev-ci-logging.XXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
server_id="$(timeout 30 "${compose[@]}" ps --quiet server)"
[[ $server_id =~ ^[a-f0-9]{12,64}$ ]]
[[ $(timeout 30 docker exec "$server_id" id -u) == 10001 ]]
[[ $(timeout 30 docker exec "$server_id" stat -c '%u:%g:%a' /var/lib/daynight/logs) == 10001:10001:700 ]]
[[ $(timeout 30 docker exec "$server_id" stat -c '%u:%g:%a' /var/lib/daynight/logs/daynight-server.log) == 10001:10001:600 ]]
timeout 30 docker exec "$server_id" cat /var/lib/daynight/logs/daynight-server.log > "$scratch/before"
[[ -s $scratch/before ]]

# Another process using the same volume must fail before touching the files.
status=0
timeout 60 "${compose[@]}" run --quiet --rm --no-deps -T server > "$scratch/lock" 2>&1 || status=$?
[[ $status -ne 0 && $status -ne 124 ]]

timeout 60 "${compose[@]}" restart --timeout 20 server
timeout 150 "${compose[@]}" up --no-build --detach --wait --wait-timeout 120 server
timeout 60 "${compose[@]}" stop --timeout 20 server
timeout 30 docker logs "$server_id" > "$scratch/stderr" 2>&1
timeout 30 docker run --rm --entrypoint cat \
  --volume "daynight-dev-ci-${DAYNIGHT_DEV_CI_RUN_ID}_server-logs:/logs:ro" \
  "$DAYNIGHT_DEV_CI_IMAGE" /logs/daynight-server.log > "$scratch/file"

# With the lock free, invalid configuration must be reported to both sinks.
status=0
timeout 60 "${compose[@]}" run --quiet --rm --no-deps -T \
  -e DAYNIGHT_PUBLIC_ORIGIN='logging-test-secret://invalid' server > "$scratch/config" 2>&1 || status=$?
[[ $status -ne 0 && $status -ne 124 ]]
timeout 30 docker run --rm --entrypoint cat \
  --volume "daynight-dev-ci-${DAYNIGHT_DEV_CI_RUN_ID}_server-logs:/logs:ro" \
  "$DAYNIGHT_DEV_CI_IMAGE" /logs/daynight-server.log > "$scratch/after"

node - "$scratch" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const parse = text => text.split('\n').flatMap(line => {
  try { return [{ line, record: JSON.parse(line) }]; } catch { return []; }
});
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const before = read('before'), file = read('file'), stderr = read('stderr');
assert(file.startsWith(before) && file.length > before.length, 'restart did not append');
assert(file === stderr, 'file and stderr differ');
const loaded = parse(file).filter(x => x.record.event === 'configuration_loaded');
assert(new Set(loaded.map(x => x.record.run_id)).size >= 2, 'missing startup run identities');
for (const item of loaded) assert(/^[0-9a-f]{32}$/.test(item.record.run_id), 'invalid run_id');
const lock = parse(read('lock')).find(x => x.record.event === 'logging_failed');
assert(lock && lock.record.phase === 'lock' && /^[0-9a-f]{32}$/.test(lock.record.run_id), 'missing lock failure');
assert(!file.includes(lock.line), 'failed contender wrote to file');
const config = parse(read('config')).find(x => x.record.component === 'configuration');
assert(config && /^[0-9a-f]{32}$/.test(config.record.run_id), 'missing configuration failure');
const after = read('after');
assert(after.startsWith(file) && after.includes(config.line + '\n'), 'configuration failure absent from file');
assert(!after.includes('logging-test-secret') && !read('config').includes('logging-test-secret'), 'secret leaked');
JS
printf '%s\n' 'Container logging check passed.'
