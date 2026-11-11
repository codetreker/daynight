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
node scripts/command-timeout.mts 300000 5000 env GOFLAGS="$lifecycle_go_flags" go build -o .tmp/daynight-server-unit ./cmd/daynight-server
node scripts/command-timeout.mts 300000 5000 env GOFLAGS="$lifecycle_go_flags" go vet ./cmd/daynight-server
# Recovery needs the loopback transport available only in this test build.
node scripts/command-timeout.mts 240000 5000 env GOFLAGS="$unit_go_flags" go test -count=1 -timeout=3m -tags=webhooktest -run '^TestWebhookRunnerAbruptProcessRecovery$' ./internal/service/webhook

command_package="$(GOFLAGS="$lifecycle_go_flags" go list -f '{{.ImportPath}}' ./cmd/daynight-server)"
GOFLAGS= node scripts/command-timeout.mts 180000 5000 go install github.com/codetreker/go-cov/cmd/go-cov@v0.1.4
go clean -testcache
export CI=true
cd -- "$DAYNIGHT_MODULE_ROOT/cmd/daynight-server"
node "$DAYNIGHT_MODULE_ROOT/scripts/command-timeout.mts" 720000 5000 env GOFLAGS="$lifecycle_go_flags -coverpkg=$command_package" \
  "$GOBIN/go-cov" --config="$DAYNIGHT_MODULE_ROOT/.go-cov.toml" --race="$race" --tags=startupshutdown --coverprofile="$profile"
node "$DAYNIGHT_MODULE_ROOT/scripts/coverage.mts" "$profile"
