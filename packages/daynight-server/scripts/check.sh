#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: bash packages/daynight-server/scripts/check.sh [--stress]" >&2
  exit 2
}
case "$#" in
  0) ;;
  1) [[ "$1" == "--stress" ]] || usage ;;
  *) usage ;;
esac

source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
cd -- "$DAYNIGHT_MODULE_ROOT"
: "${DAYNIGHT_TEST_DATABASE_URL:?Set DAYNIGHT_TEST_DATABASE_URL to the required PostgreSQL test database}"

export COREPACK_HOME="$DAYNIGHT_MODULE_ROOT/.tmp/corepack"
pnpm --dir "$DAYNIGHT_MODULE_ROOT/../.." web:build

# Both local and CI runs use the checked-in coverage rules.
unset COVERPROFILE MODULE_PREFIX PROJECT_NAME HTML_OUT THRESHOLD_FUNC \
  THRESHOLD_PACKAGE THRESHOLD_PRINT THRESHOLD_TOTAL UNCOVERED_LIMIT \
  EXCLUDE_PACKAGES SKIP_RESULT_PACKAGES EXCLUDE_FILES EXCLUDE_FUNCS \
  EXCLUDE_FUNC_SUFFIXES TEST_TIMEOUT BUILD_TAGS GENERATE_HTML \
  RACE_DETECTION FAIL_ON_CRITICAL_BLOCKS

node --test scripts/coverage.test.mts
go build -o .tmp/daynight-server ./cmd/daynight-server
go vet ./...
DAYNIGHT_TEST_UNIAUTH_FIXTURE="$(node scripts/prepare-uniauth-fixture.mts)"
export DAYNIGHT_TEST_UNIAUTH_FIXTURE
node --test scripts/auth-fixture.test.mts scripts/preparation-lock.test.mts
# Database state is outside Go's test-result cache key.
# https://github.com/golang/go/blob/go1.27.2/src/cmd/go/internal/test/test.go#L1867-L1869
go clean -testcache
node "$DAYNIGHT_MODULE_ROOT/../daynight/scripts/project-task-acceptance.ts" "$@"
