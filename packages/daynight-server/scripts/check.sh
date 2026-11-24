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

module_go_flags="$unit_go_flags"
if [[ -n "${CI:-}" && "${GITHUB_EVENT_NAME:-}" == pull_request ]]; then
  module_go_flags+=" -p=4"
fi

if [[ -n "${CI:-}" && "${GITHUB_EVENT_NAME:-}" == pull_request ]]; then
  fixture_dir="$(mktemp -d "$TMPDIR/check-fixture.XXXXXXXX")"
  trap 'rm -rf -- "$fixture_dir"' EXIT
  UNIT_GO_FLAGS="$unit_go_flags" node scripts/parallel-check-preparation.mts "$fixture_dir/result"
  DAYNIGHT_TEST_UNIAUTH_FIXTURE="$(cat -- "$fixture_dir/result")"
  rm -rf -- "$fixture_dir"
  trap - EXIT
  export DAYNIGHT_TEST_UNIAUTH_FIXTURE
else
  node --test scripts/coverage.test.mts scripts/check.test.mts scripts/validation-env.test.mts scripts/command-timeout.test.mts scripts/go-cov-capture.test.mts scripts/parallel-check-preparation.test.mts
  started=$SECONDS
  DAYNIGHT_TEST_UNIAUTH_FIXTURE="$(node scripts/prepare-uniauth-fixture.mts)"
  export DAYNIGHT_TEST_UNIAUTH_FIXTURE
  # Go's ./... discovery excludes testdata; verify this shared fixture explicitly.
  GOFLAGS="$unit_go_flags" go test -count=1 -timeout=30s ./testdata/testauth
  printf 'Authentication fixture validation completed in %ss\n' "$((SECONDS - started))"
fi
# Database state is outside Go's test-result cache key.
# https://github.com/golang/go/blob/go1.27.2/src/cmd/go/internal/test/test.go#L1867-L1869
go clean -testcache

export CI=true
command_package="$(GOFLAGS="$unit_go_flags" go list -f '{{.ImportPath}}' ./cmd/daynight-server)"
packages="$(GOFLAGS="$unit_go_flags" go list -f '{{if or .GoFiles .CgoFiles}}{{.ImportPath}}{{end}}' ./... | awk -v command_package="$command_package" '$0 != command_package && $0 != ""' | paste -sd, -)"
[[ -n "$packages" ]] || { printf '%s\n' 'No production packages found.' >&2; exit 1; }
GOFLAGS= go install github.com/codetreker/go-cov/cmd/go-cov@v0.1.4
started=$SECONDS
node scripts/command-timeout.mts 1800000 5000 env GOFLAGS="$module_go_flags -vet=all -coverpkg=$packages" \
  node scripts/go-cov-capture.mts module "$(command -v go)" "$GOBIN/go-cov" --race="$race" --exclude-packages="$command_package"
node scripts/coverage.mts coverage.out
printf 'Module vet, tests and coverage completed in %ss\n' "$((SECONDS - started))"
