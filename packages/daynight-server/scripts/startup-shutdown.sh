#!/usr/bin/env bash
set -euo pipefail

if (( $# != 0 )); then
  printf '%s\n' 'Usage: bash scripts/startup-shutdown.sh' >&2
  exit 1
fi

source "$(dirname -- "${BASH_SOURCE[0]}")/validation-env.sh"
profile="$DAYNIGHT_MODULE_ROOT/startup-shutdown-coverage.out"
rm -f -- "$profile"

node --test scripts/startup-shutdown.test.mts
DAYNIGHT_TEST_UNIAUTH_FIXTURE="$(node scripts/prepare-uniauth-fixture.mts)"
export DAYNIGHT_TEST_UNIAUTH_FIXTURE

lifecycle_go_flags="$unit_go_flags -tags=startupshutdown"
timeout --signal=TERM --kill-after=5s 5m env GOFLAGS="$lifecycle_go_flags" go build -o .tmp/daynight-server-unit ./cmd/daynight-server
timeout --signal=TERM --kill-after=5s 5m env GOFLAGS="$lifecycle_go_flags" go vet ./cmd/daynight-server
# Recovery needs the loopback transport available only in this test build.
timeout --signal=TERM --kill-after=5s 4m env GOFLAGS="$unit_go_flags" go test -count=1 -timeout=3m -tags=webhooktest -run '^TestWebhookRunnerAbruptProcessRecovery$' ./internal/server

command_package="$(GOFLAGS="$lifecycle_go_flags" go list -f '{{.ImportPath}}' ./cmd/daynight-server)"
GOFLAGS= timeout --signal=TERM --kill-after=5s 3m go install github.com/codetreker/go-cov/cmd/go-cov@v0.1.4
go clean -testcache
export CI=true
cd -- "$DAYNIGHT_MODULE_ROOT/cmd/daynight-server"
timeout --signal=TERM --kill-after=5s 12m env GOFLAGS="$lifecycle_go_flags -coverpkg=$command_package" \
  "$GOBIN/go-cov" --config="$DAYNIGHT_MODULE_ROOT/.go-cov.toml" --race="$race" --tags=startupshutdown --coverprofile="$profile"
node "$DAYNIGHT_MODULE_ROOT/scripts/coverage.mts" "$profile"
