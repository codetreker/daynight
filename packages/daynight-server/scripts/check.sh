#!/usr/bin/env bash
set -euo pipefail

if (( $# != 0 )); then
  if (( $# != 1 )) || [[ "$1" != --coverage ]]; then
    printf '%s\n' 'Usage: bash scripts/check.sh [--coverage]' >&2
    exit 1
  fi
  shift
fi

case "${DAYNIGHT_TEST_RACE-true}" in
  true|false) race="${DAYNIGHT_TEST_RACE-true}" ;;
  *) printf '%s\n' 'DAYNIGHT_TEST_RACE must be true or false.' >&2; exit 1 ;;
esac

source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
cd -- "$DAYNIGHT_MODULE_ROOT"
: "${DAYNIGHT_TEST_DATABASE_URL:?Set DAYNIGHT_TEST_DATABASE_URL to the required PostgreSQL test database}"
rm -f coverage.out

export COREPACK_HOME="$DAYNIGHT_MODULE_ROOT/.tmp/corepack"
pnpm --dir "$DAYNIGHT_MODULE_ROOT/../.." web:build

# Coverage gates use the checked-in rules; the runner selects race instrumentation.
unset COVERPROFILE MODULE_PREFIX PROJECT_NAME HTML_OUT THRESHOLD_FUNC \
  THRESHOLD_PACKAGE THRESHOLD_PRINT THRESHOLD_TOTAL UNCOVERED_LIMIT \
  EXCLUDE_PACKAGES SKIP_RESULT_PACKAGES EXCLUDE_FILES EXCLUDE_FUNCS \
  EXCLUDE_FUNC_SUFFIXES TEST_TIMEOUT BUILD_TAGS GENERATE_HTML \
  RACE_DETECTION FAIL_ON_CRITICAL_BLOCKS

go build -o .tmp/daynight-server ./cmd/daynight-server
go vet ./...
DAYNIGHT_TEST_UNIAUTH_FIXTURE="$(node scripts/prepare-uniauth-fixture.mts)"
export DAYNIGHT_TEST_UNIAUTH_FIXTURE
# Database state is outside Go's test-result cache key.
# https://github.com/golang/go/blob/go1.27.2/src/cmd/go/internal/test/test.go#L1867-L1869
go clean -testcache

# Assembled backend tests must instrument their imported production packages.
coverage_packages="$(go list ./...)"
export GOFLAGS="${GOFLAGS:+$GOFLAGS }-coverpkg=${coverage_packages//$'\n'/,}"
export RACE_DETECTION="$race"
if [[ "$race" == false ]]; then
  # go-cov omits -race=false, so override inherited race instrumentation explicitly.
  export GOFLAGS="$GOFLAGS -race=false"
fi

export CI=true
go run github.com/codetreker/go-cov/cmd/go-cov@v0.1.0 --coverprofile=coverage.out --skip-result-packages tests/ "$@"
node scripts/coverage.mts coverage.out
