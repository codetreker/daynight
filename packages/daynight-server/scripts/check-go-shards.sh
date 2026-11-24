#!/usr/bin/env bash
set -euo pipefail

if (( $# != 0 )); then
  printf '%s\n' 'Usage: bash scripts/check-go-shards.sh' >&2
  exit 1
fi

source "$(dirname -- "${BASH_SOURCE[0]}")/validation-env.sh" --coverage-report
export CI=true
export GOFLAGS="$unit_go_flags"
GOFLAGS= go install github.com/codetreker/go-cov/cmd/go-cov@v0.1.4
node scripts/command-timeout.mts 180000 5000 node scripts/go-shard-coverage.mts report \
  "$DAYNIGHT_MODULE_ROOT/.tmp/go-shard" "$race" "$(command -v go)" "$GOBIN/go-cov"
node scripts/coverage.mts coverage.out
