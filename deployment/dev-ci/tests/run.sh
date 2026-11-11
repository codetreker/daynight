#!/usr/bin/env bash
set -euo pipefail

test_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
runner="$test_dir/../run.sh"
repository_dir="$(cd -- "$test_dir/../../.." && pwd)"
mkdir -p "$repository_dir/.tmp"
fixture_root="$(mktemp -d "$repository_dir/.tmp/dev-ci-runner-tests.XXXXXX")"
fixture_pid=''
cleanup() {
  if [[ -n $fixture_pid ]]; then kill -TERM "$fixture_pid" 2>/dev/null || true; fi
  local identity project group
  for identity in "$fixture_root"/*/callback-group; do
    [[ -f $identity ]] || continue
    group="$(< "$identity")"
    [[ $group =~ ^[0-9]+$ && $group -gt 1 ]] || continue
    kill -KILL -- "-$group" 2>/dev/null || true
  done
  for identity in "$fixture_root"/*/project; do
    [[ -f $identity ]] || continue
    project="$(< "$identity")"
    [[ $project =~ ^daynight-dev-ci-[0-9]{14}-[0-9]+-[0-9]{5}$ ]] || continue
    rm -rf -- "$repository_dir/.tmp/dev-ci/${project#daynight-dev-ci-}"
    rm -rf -- "$repository_dir/.tmp/dev-ci-private/${project#daynight-dev-ci-}"
    rm -rf -- "$repository_dir/.tmp/dev-ci-config/${project#daynight-dev-ci-}"
  done
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT
export PATH="$test_dir:$PATH"
export COMPOSE_PROJECT_NAME=daynight-localhost
export COMPOSE_FILE=/not/the/dev-ci/file
export DAYNIGHT_PORT=8787
export DAYNIGHT_UNIAUTH_CALLBACK_URL=https://unrelated.example/auth/callback
export DAYNIGHT_DEV_CI_FIXTURE_PORT=1
export DAYNIGHT_UNIAUTH_FIXTURE_BINARY="$fixture_root/uniauth-fixture-linux-amd64"
export DEV_CI_TEST_NODE="$(command -v node)"
node() {
  if [[ ${1:-} == */packages/daynight-server/scripts/prepare-uniauth-fixture.mts ]]; then
    [[ $# -eq 2 && $2 =~ ^--target=linux/(amd64|arm64)$ ]] || return 83
    local architecture=${BASH_REMATCH[1]} binary
    binary="$FAKE_DOCKER_STATE/fixture-linux-$architecture"
    printf 'prepare-target %s\n' "$architecture" >> "$FAKE_DOCKER_STATE/calls"
    "$DEV_CI_TEST_NODE" - "$binary" "$architecture" <<'JS'
const fs = require('node:fs');
const header = Buffer.alloc(20);
header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
header.writeUInt16LE(process.argv[3] === 'amd64' ? 62 : 183, 18);
fs.writeFileSync(process.argv[2], header, { mode: 0o700 });
JS
    printf '%s\n' "$binary"
  else "$DEV_CI_TEST_NODE" "$@"; fi
}
export -f node
node - "$DAYNIGHT_UNIAUTH_FIXTURE_BINARY" <<'JS'
const fs = require('node:fs');
const header = Buffer.alloc(20);
header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
header.writeUInt16LE(62, 18);
fs.writeFileSync(process.argv[2], header, { mode: 0o700 });
JS

assert_contains() {
  local path=$1 expected=$2 contents
  contents="$(< "$path")"
  [[ $contents == *"$expected"* ]] || {
    printf 'Missing %s in %s\n' "$expected" "$path" >&2
    exit 1
  }
}

manifest_for() {
  local state=$1 project
  project="$(< "$state/project")"
  printf '%s/.tmp/dev-ci/%s/manifest.json' "$repository_dir" "${project#daynight-dev-ci-}"
}

run_case() {
  local scenario=$1 expected_status=$2
  shift 2
  export FAKE_DOCKER_SCENARIO=$scenario
  export FAKE_DOCKER_STATE="$fixture_root/$scenario"
  mkdir "$FAKE_DOCKER_STATE"
  local status=0
  bash "$runner" "$@" > "$FAKE_DOCKER_STATE/output" 2>&1 || status=$?
  [[ $status -eq $expected_status ]] || {
    cat "$FAKE_DOCKER_STATE/output"
    printf 'Scenario %s returned %s, expected %s\n' "$scenario" "$status" "$expected_status" >&2
    exit 1
  }
  local manifest
  manifest="$(manifest_for "$FAKE_DOCKER_STATE")"
  assert_contains "$manifest" '"schemaVersion":1'
  assert_contains "$manifest" '"phase":"finished"'
  [[ ! -e ${manifest%manifest.json}.bootstrap.pipe ]]
  if [[ $scenario == attachment-volume-left || $scenario == log-volume-left ]]; then
    assert_contains "$manifest" '"cleanupResult":"failed"'
    [[ -f $FAKE_DOCKER_STATE/${scenario%-left} && -f $FAKE_DOCKER_STATE/image ]]
  elif [[ $scenario == cleanup-failure* ]]; then
    assert_contains "$manifest" '"cleanupResult":"failed"'
    [[ -f $FAKE_DOCKER_STATE/resources && -f $FAKE_DOCKER_STATE/image ]]
  else
    assert_contains "$manifest" '"cleanupResult":"passed"'
    [[ ! -f $FAKE_DOCKER_STATE/resources && ! -f $FAKE_DOCKER_STATE/image ]]
  fi
  [[ $(< "$FAKE_DOCKER_STATE/calls") != *daynight-localhost* ]]
  [[ $(< "$FAKE_DOCKER_STATE/output") != *private-fixture-secret* ]]
  [[ $(< "$manifest") != *private-fixture-secret* ]]
  local private_dir="$repository_dir/.tmp/dev-ci-private/$(< "$FAKE_DOCKER_STATE/project")"
  private_dir=${private_dir/daynight-dev-ci-/}
  local run_project="$(< "$FAKE_DOCKER_STATE/project")"
  local config_dir="$repository_dir/.tmp/dev-ci-config/${run_project#daynight-dev-ci-}"
  if [[ $scenario != cleanup-failure* && $scenario != attachment-volume-left && $scenario != log-volume-left ]]; then
    [[ ! -d $private_dir && ! -d $config_dir ]]
  else
    [[ -f $config_dir/config.yml ]]
    [[ $(< "$private_dir/auth.env") != *private-fixture-secret* ]]
    [[ $(< "$private_dir/auth-state.json") != *private-fixture-secret* ]]
  fi
  printf 'PASS %s\n' "$scenario"
}

export FAKE_DOCKER_STATE="$fixture_root/guard"
mkdir "$FAKE_DOCKER_STATE"
for invalid in '' daynight-localhost ../daynight-localhost 20200101000000-1-12345/..; do
  status=0
  bash "$runner" --cleanup "$invalid" > "$FAKE_DOCKER_STATE/output" 2>&1 || status=$?
  [[ $status -eq 2 && ! -f $FAKE_DOCKER_STATE/calls ]]
done
status=0
bash "$runner" --cleanup 20200101000000-1-12345 > "$FAKE_DOCKER_STATE/output" 2>&1 || status=$?
[[ $status -eq 2 && ! -f $FAKE_DOCKER_STATE/calls ]]
printf '%s\n' 'PASS unsafe or unknown recovery identity'

run_case passed 0 bash -c '[[ $DAYNIGHT_BASE_URL == http://127.0.0.1:32777 && $DAYNIGHT_DEV_CI_RUN_ID =~ ^[0-9]{14}-[0-9]+-[0-9]{5}$ ]]'
assert_contains "$(manifest_for "$FAKE_DOCKER_STATE")" '"result":"passed"'
assert_contains "$(manifest_for "$FAKE_DOCKER_STATE")" '"imageId":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
assert_contains "$(manifest_for "$FAKE_DOCKER_STATE")" '"containerIds":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]'
project="$(< "$FAKE_DOCKER_STATE/project")"
assert_contains "$(manifest_for "$FAKE_DOCKER_STATE")" "\"volumeNames\":[\"${project}_postgres-data\",\"${project}_attachment-data\",\"${project}_server-logs\"]"
run_case build-failure 30 true
run_case fixture-architecture 1 true
fixture_override=$DAYNIGHT_UNIAUTH_FIXTURE_BINARY
unset DAYNIGHT_UNIAUTH_FIXTURE_BINARY
run_case builder-platform 0 true
assert_contains "$FAKE_DOCKER_STATE/calls" 'prepare-target arm64'
assert_contains "$FAKE_DOCKER_STATE/calls" 'prepare-target amd64'
export DAYNIGHT_UNIAUTH_FIXTURE_BINARY=$fixture_override
run_case partial-startup 31 true
run_case fixture-invalid 1 true
run_case port-conflict 0 true
assert_contains "$FAKE_DOCKER_STATE/calls" 'rm --stop --force gateway'
run_case reconfigure 0 bash -c '
  [[ -s $DAYNIGHT_DEV_CI_AUTH_ENV_FILE && -s $DAYNIGHT_AUTH_FIXTURE_DESCRIPTOR ]]
  bash "$1" --reconfigure "$DAYNIGHT_DEV_CI_RUN_ID" --bootstrap
  bash "$1" --reconfigure "$DAYNIGHT_DEV_CI_RUN_ID"
  [[ $(< "$DAYNIGHT_AUTH_FIXTURE_DESCRIPTOR") == *"http://127.0.0.1:32779/auth/callback"* ]]
' bash "$runner"
assert_contains "$(manifest_for "$FAKE_DOCKER_STATE")" '"baseUrl":"http://127.0.0.1:32779"'
run_case image-mismatch 1 true
run_case child-failure 47 bash -c 'exit 47'
assert_contains "$(manifest_for "$FAKE_DOCKER_STATE")" '"result":"failed"'
run_case cleanup-failure 1 true
run_case cleanup-failure-child 47 bash -c 'exit 47'

failed_manifest="$(manifest_for "$FAKE_DOCKER_STATE")"
project="$(< "$FAKE_DOCKER_STATE/project")"
export FAKE_DOCKER_SCENARIO=passed
bash "$runner" --cleanup "${project#daynight-dev-ci-}" > "$FAKE_DOCKER_STATE/recovery-output" 2>&1
assert_contains "${failed_manifest%manifest.json}recovery-manifest.json" '"cleanupResult":"passed"'
[[ ! -f $FAKE_DOCKER_STATE/resources && ! -f $FAKE_DOCKER_STATE/image ]]
assert_contains "$failed_manifest" '"cleanupResult":"failed"'
printf '%s\n' 'PASS bounded recovery retains original receipt'
run_case attachment-volume-left 1 true
run_case log-volume-left 1 true
project="$(< "$FAKE_DOCKER_STATE/project")"
rm "$FAKE_DOCKER_STATE/log-volume"
export FAKE_DOCKER_SCENARIO=passed
bash "$runner" --cleanup "${project#daynight-dev-ci-}" > "$FAKE_DOCKER_STATE/recovery-output" 2>&1
assert_contains "$(manifest_for "$FAKE_DOCKER_STATE" | sed 's/manifest.json$/recovery-manifest.json/')" '"cleanupResult":"passed"'
[[ ! -f $FAKE_DOCKER_STATE/image ]]

for callback_status in 0 49; do
  run_case "descendant-$callback_status" "$callback_status" bash -c '
    printf "%s\n" "$$" > "$FAKE_DOCKER_STATE/callback-group"
    bash -c '\''while :; do printf x >> "$FAKE_DOCKER_STATE/heartbeat"; sleep 0.02; done'\'' &
    printf "%s\n" "$!" > "$FAKE_DOCKER_STATE/descendant-pid"
    for ((attempt=0; attempt<100; attempt++)); do
      [[ ! -s $FAKE_DOCKER_STATE/heartbeat ]] || break
      sleep 0.01
    done
    [[ -s $FAKE_DOCKER_STATE/heartbeat ]] || exit 98
    exit "$1"
  ' bash "$callback_status"
  heartbeat="$(< "$FAKE_DOCKER_STATE/heartbeat")"
  sleep 0.15
  [[ $(< "$FAKE_DOCKER_STATE/heartbeat") == "$heartbeat" ]]
  descendant="$(< "$FAKE_DOCKER_STATE/descendant-pid")"
  state="$(ps -o stat= -p "$descendant" || true)"
  [[ -z $state || $state == Z* ]]
done
printf '%s\n' 'PASS callback descendants stop after success and failure'

mkdir() {
  command mkdir "$@"
  if [[ ${FAKE_MKDIR_WAIT:-} == 1 && $* == *'/.tmp/dev-ci-config/'* ]]; then
    printf ready > "$FAKE_DOCKER_STATE/config-created"
    while [[ ! -f $FAKE_DOCKER_STATE/config-release ]]; do sleep 0.02; done
  fi
}
export -f mkdir
export FAKE_DOCKER_SCENARIO=passed FAKE_MKDIR_WAIT=1
export FAKE_DOCKER_STATE="$fixture_root/cancelled-config"
command mkdir "$FAKE_DOCKER_STATE"
bash "$runner" true > "$FAKE_DOCKER_STATE/output" 2>&1 &
fixture_pid=$!
for ((attempt=0; attempt<100; attempt++)); do
  [[ ! -f $FAKE_DOCKER_STATE/config-created ]] || break
  sleep 0.05
done
[[ -f $FAKE_DOCKER_STATE/config-created ]]
kill -TERM "$fixture_pid"
touch "$FAKE_DOCKER_STATE/config-release"
status=0
wait "$fixture_pid" || status=$?
fixture_pid=''
[[ $status -eq 143 ]]
run_id="$(sed -n 's/^Dev-ci run ID: //p' "$FAKE_DOCKER_STATE/output")"
[[ $run_id =~ ^[0-9]{14}-[0-9]+-[0-9]{5}$ && ! -d $repository_dir/.tmp/dev-ci-config/$run_id ]]
rm -rf -- "$repository_dir/.tmp/dev-ci/$run_id"
unset FAKE_MKDIR_WAIT
unset -f mkdir
printf '%s\n' 'PASS cancellation while creating run configuration'

for cancellation_phase in callback bootstrap; do
  export FAKE_DOCKER_SCENARIO="cancelled-$cancellation_phase"
  export FAKE_DOCKER_STATE="$fixture_root/$FAKE_DOCKER_SCENARIO"
  mkdir "$FAKE_DOCKER_STATE"
  bash "$runner" bash -c 'printf ready > "$FAKE_DOCKER_STATE/child-ready"; sleep 60' > "$FAKE_DOCKER_STATE/output" 2>&1 &
  fixture_pid=$!
  for ((attempt=0; attempt<100; attempt++)); do
    [[ ! -f $FAKE_DOCKER_STATE/child-ready ]] || break
    sleep 0.05
  done
  [[ -f $FAKE_DOCKER_STATE/child-ready ]]
  kill -TERM "$fixture_pid"
  status=0
  wait "$fixture_pid" || status=$?
  fixture_pid=''
  [[ $status -eq 143 ]]
  assert_contains "$(manifest_for "$FAKE_DOCKER_STATE")" '"result":"cancelled"'
  assert_contains "$(manifest_for "$FAKE_DOCKER_STATE")" '"cleanupResult":"passed"'
  [[ ! -f $FAKE_DOCKER_STATE/resources && ! -f $FAKE_DOCKER_STATE/image ]]
  cancelled_manifest="$(manifest_for "$FAKE_DOCKER_STATE")"
  [[ ! -e ${cancelled_manifest%manifest.json}.bootstrap.pipe ]]
  while read -r process_pid process_command; do
    [[ $process_command != "tee ${cancelled_manifest%manifest.json}bootstrap.log" ]]
  done < <(ps -axo pid=,command=)
  printf 'PASS %s signal cancellation\n' "$cancellation_phase"
done
printf '%s\n' 'All dev-ci runner tests passed.'
