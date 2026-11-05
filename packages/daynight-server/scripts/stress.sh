#!/usr/bin/env bash
set -euo pipefail

if (( $# != 0 )); then
  printf '%s\n' 'Usage: bash scripts/stress.sh' >&2
  exit 1
fi
if [[ -n "${CI:-}" ]]; then
  printf '%s\n' 'Stress tests are local-only and cannot run in CI.' >&2
  exit 1
fi

source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
cd -- "$DAYNIGHT_MODULE_ROOT"
: "${DAYNIGHT_TEST_DATABASE_URL:?Set DAYNIGHT_TEST_DATABASE_URL to an isolated PostgreSQL test database}"

export COREPACK_HOME="$DAYNIGHT_MODULE_ROOT/.tmp/corepack"
pnpm --dir "$DAYNIGHT_MODULE_ROOT/../.." web:build
DAYNIGHT_TEST_UNIAUTH_FIXTURE="$(node scripts/prepare-uniauth-fixture.mts)"
export DAYNIGHT_TEST_UNIAUTH_FIXTURE

for stress_package in ./internal/server ./internal/core/session/protocol/v2 ./internal/filestorage/local; do
  go test -v -tags stress -run '^TestStress' -race -count=1 -timeout=10m "$stress_package"
done
