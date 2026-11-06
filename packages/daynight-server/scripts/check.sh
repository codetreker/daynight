#!/usr/bin/env bash
set -euo pipefail

if (( $# != 0 )); then
  if (( $# != 1 )) || [[ "$1" != --coverage ]]; then
    printf '%s\n' 'Usage: bash scripts/check.sh [--coverage]' >&2
    exit 1
  fi
  shift
fi

source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
cd -- "$DAYNIGHT_MODULE_ROOT"
: "${DAYNIGHT_TEST_DATABASE_URL:?Set DAYNIGHT_TEST_DATABASE_URL to the required PostgreSQL test database}"
rm -f coverage.out

# Unit validation embeds fixed test resources; product builds retain the real
# Web bundle requirement.
# Migration fixtures share a database-wide advisory lock across isolated schemas.
unit_go_flags="${GOFLAGS:+$GOFLAGS }-p=2 -overlay=scripts/unit-overlay.json"

# CI and local runs use the same coverage gates, with race detection locally.
unset COVERPROFILE MODULE_PREFIX PROJECT_NAME HTML_OUT THRESHOLD_FUNC \
  THRESHOLD_PACKAGE THRESHOLD_PRINT THRESHOLD_TOTAL UNCOVERED_LIMIT \
  EXCLUDE_PACKAGES SKIP_RESULT_PACKAGES EXCLUDE_FILES EXCLUDE_FUNCS \
  EXCLUDE_FUNC_SUFFIXES TEST_TIMEOUT BUILD_TAGS GENERATE_HTML \
  RACE_DETECTION FAIL_ON_CRITICAL_BLOCKS

race=true
if [[ -n "${CI:-}" ]]; then race=false; fi
if [[ "$race" == false ]]; then unit_go_flags="$unit_go_flags -race=false"; fi

node --test scripts/coverage.test.mts scripts/check.test.mts
GOFLAGS="$unit_go_flags" go build -o .tmp/daynight-server-unit ./cmd/daynight-server
GOFLAGS="$unit_go_flags" go vet ./...
DAYNIGHT_TEST_UNIAUTH_FIXTURE="$(node scripts/prepare-uniauth-fixture.mts)"
export DAYNIGHT_TEST_UNIAUTH_FIXTURE
# Go's ./... discovery excludes testdata; verify this shared fixture explicitly.
go test -count=1 -timeout=30s ./testdata/testauth
# Database state is outside Go's test-result cache key.
# https://github.com/golang/go/blob/go1.27.2/src/cmd/go/internal/test/test.go#L1867-L1869
go clean -testcache

export CI=true
packages="$(GOFLAGS="$unit_go_flags" go list -f '{{if or .GoFiles .CgoFiles}}{{.ImportPath}}{{end}}' ./... | paste -sd, -)"
[[ -n "$packages" ]] || { printf '%s\n' 'No production packages found.' >&2; exit 1; }
GOFLAGS= go install github.com/codetreker/go-cov/cmd/go-cov@v0.1.4
GOFLAGS="$unit_go_flags -coverpkg=$packages" "$GOBIN/go-cov" --race="$race"
node scripts/coverage.mts coverage.out
