#!/usr/bin/env bash
set -euo pipefail

if (( $# != 0 )); then
  if (( $# != 1 )) || [[ "$1" != --coverage ]]; then
    printf '%s\n' 'Usage: bash scripts/check.sh [--coverage]' >&2
    exit 1
  fi
  shift
fi

source "$(dirname -- "${BASH_SOURCE[0]}")/validation-env.sh"
: "${DAYNIGHT_TEST_REDIS_URL:?Set DAYNIGHT_TEST_REDIS_URL to an isolated Redis test instance}"
rm -f coverage.out

node --test scripts/coverage.test.mts scripts/check.test.mts scripts/validation-env.test.mts scripts/command-timeout.test.mts scripts/go-cov-capture.test.mts
GOFLAGS="$unit_go_flags" go vet ./...
DAYNIGHT_TEST_UNIAUTH_FIXTURE="$(node scripts/prepare-uniauth-fixture.mts)"
export DAYNIGHT_TEST_UNIAUTH_FIXTURE
# Go's ./... discovery excludes testdata; verify this shared fixture explicitly.
GOFLAGS="$unit_go_flags" go test -count=1 -timeout=30s ./testdata/testauth
# Database state is outside Go's test-result cache key.
# https://github.com/golang/go/blob/go1.27.2/src/cmd/go/internal/test/test.go#L1867-L1869
go clean -testcache

export CI=true
command_package="$(GOFLAGS="$unit_go_flags" go list -f '{{.ImportPath}}' ./cmd/daynight-server)"
packages="$(GOFLAGS="$unit_go_flags" go list -f '{{if or .GoFiles .CgoFiles}}{{.ImportPath}}{{end}}' ./... | awk -v command_package="$command_package" '$0 != command_package && $0 != ""' | paste -sd, -)"
[[ -n "$packages" ]] || { printf '%s\n' 'No production packages found.' >&2; exit 1; }
GOFLAGS= go install github.com/codetreker/go-cov/cmd/go-cov@v0.1.4
node scripts/command-timeout.mts 1800000 5000 env GOFLAGS="$unit_go_flags -coverpkg=$packages" \
  node scripts/go-cov-capture.mts module "$(command -v go)" "$GOBIN/go-cov" --race="$race" --exclude-packages="$command_package"
node scripts/coverage.mts coverage.out
