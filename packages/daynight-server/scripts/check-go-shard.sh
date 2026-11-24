#!/usr/bin/env bash
set -euo pipefail

if (( $# != 1 )) || [[ "$1" != root && "$1" != store-a && "$1" != store-b && "$1" != other && "$1" != preflight ]]; then
  printf '%s\n' 'Usage: bash scripts/check-go-shard.sh root|store-a|store-b|other|preflight' >&2
  exit 1
fi

shard="$1"
source "$(dirname -- "${BASH_SOURCE[0]}")/validation-env.sh"
: "${DAYNIGHT_TEST_REDIS_URL:?Set DAYNIGHT_TEST_REDIS_URL to an isolated Redis test instance}"

stage() {
  local name="$1" started="$SECONDS"
  shift
  printf 'Starting %s\n' "$name"
  "$@"
  printf '%s completed in %s seconds\n' "$name" "$((SECONDS - started))"
}

prepare_auth_fixture() {
  local started="$SECONDS"
  DAYNIGHT_TEST_UNIAUTH_FIXTURE="$(node scripts/prepare-uniauth-fixture.mts)"
  export DAYNIGHT_TEST_UNIAUTH_FIXTURE
  printf 'UniAuth fixture preparation completed in %s seconds\n' "$((SECONDS - started))"
}

if [[ "$shard" == preflight ]]; then
  stage 'Go validation script tests' node --test scripts/coverage.test.mts scripts/check.test.mts \
    scripts/validation-env.test.mts scripts/command-timeout.test.mts scripts/go-cov-capture.test.mts \
    scripts/go-shard-*.test.mts
  stage 'go vet' env GOFLAGS="$unit_go_flags" go vet ./...
  prepare_auth_fixture
  # The module package list excludes the testdata fixture.
  stage 'testauth fixture tests' env GOFLAGS="$unit_go_flags" go test -count=1 -timeout=30s ./testdata/testauth
  exit 0
fi

if [[ "$shard" == root ]]; then
  : "${DAYNIGHT_TEST_STORE_ROOT_DATABASE_URL:?Set DAYNIGHT_TEST_STORE_ROOT_DATABASE_URL to the dedicated Store test database}"
elif [[ "$shard" == other ]]; then
  prepare_auth_fixture
fi

started="$SECONDS"
source_revision="$(git rev-parse HEAD)"
module_path="$(GOFLAGS="$unit_go_flags" go list -m -f '{{.Path}}')"
inventory="$(GOFLAGS="$unit_go_flags" go list -f '{{.ImportPath}}{{if or .GoFiles .CgoFiles}} production{{end}}' ./...)"
plan="$(cut -d' ' -f1 <<< "$inventory" | node scripts/go-shard-plan.mts plan "$module_path")"
package_list="$(jq -er --arg shard "$shard" '.[$shard][]' <<< "$plan")"
mapfile -t targets <<< "$package_list"
production_packages="$(awk -v command_package="$module_path/cmd/daynight-server" '$2 == "production" && $1 != command_package { print $1 }' <<< "$inventory" | paste -sd, -)"
[[ -n "$production_packages" ]] || { printf '%s\n' 'No production packages found.' >&2; exit 1; }
printf 'Go package discovery completed in %s seconds\n' "$((SECONDS - started))"

directory="$DAYNIGHT_MODULE_ROOT/.tmp/go-shard/$shard"
mkdir -p -- "$(dirname -- "$directory")"
mkdir -- "$directory"
real_go="$(command -v go)"
export CI=true

# Each shard measures all production packages. Count one forces real execution
# even when the build cache has a successful result for a test binary.
execute_shard() {
  node scripts/command-timeout.mts 1800000 5000 env GOFLAGS="$unit_go_flags" \
    node scripts/go-test-output.mts "$real_go" "$directory" test -count=1 -json -covermode=atomic \
      -timeout=10m "-coverpkg=$production_packages" "-coverprofile=$directory/coverage.raw" "${targets[@]}" |
    jq --unbuffered -c 'select(.Test == null or .Action == "fail")'
}
stage 'go test' execute_shard

stage 'Coverage profile compaction' node scripts/go-shard-coverage.mts compact "$directory/coverage.raw" "$directory/coverage.out"
rm -- "$directory/coverage.raw"
node --input-type=module - "$directory/receipt.json" "$source_revision" "$race" "$shard" "${targets[@]}" <<'JS'
import { writeFileSync } from 'node:fs';

const [path, source, race, shard, ...packages] = process.argv.slice(2);
writeFileSync(path, JSON.stringify({ version: 1, shard, source, race: race === 'true', packages }) + '\n', { flag: 'wx' });
JS
