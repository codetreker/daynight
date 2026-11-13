#!/usr/bin/env bash
set -euo pipefail

if (( $# > 1 )) || { (( $# == 1 )) && [[ "$1" != --cleanup ]]; }; then
  printf '%s\n' 'Usage: bash scripts/integration.sh [--cleanup]' >&2
  exit 2
fi

source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
cd -- "$DAYNIGHT_MODULE_ROOT"
if [[ "${1:-}" == --cleanup ]]; then
  timeout --signal=TERM --kill-after=5s 2m node scripts/integration-runtime.mts cleanup-all
  exit
fi
if [[ "$(uname -s)" != Linux ]]; then
  printf '%s\n' 'Go API integration currently requires Linux process ownership checks' >&2
  exit 1
fi

repository_root="$(git rev-parse --show-toplevel)"
run_root="$(mktemp -d "$DAYNIGHT_MODULE_ROOT/.tmp/integration.XXXXXXXX")"
evidence_root="$DAYNIGHT_MODULE_ROOT/.tmp/integration-results/$(basename "$run_root")"
mkdir -p -- "$evidence_root"
export DAYNIGHT_INTEGRATION_RUN_ROOT="$run_root"
cleanup() {
  local result=$?
  if ! timeout --signal=TERM --kill-after=5s 2m node scripts/integration-runtime.mts finish "$run_root" "$result"; then
    if (( result == 0 )); then result=1; fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
exec > >(tee -a "$evidence_root/run.log") 2>&1
node scripts/integration-runtime.mts initialize "$run_root" "$$"

if [[ ! -f internal/service/webui/dist/index.html ]] || [[ ! -d internal/service/webui/dist/assets ]]; then
  printf '%s\n' 'Build the production Web resources before running Go API integration tests' >&2
  exit 1
fi

if [[ -z "${DAYNIGHT_TEST_DATABASE_URL:-}" ]]; then
  database_container="daynight-api-$(basename "$run_root")"
  node scripts/integration-runtime.mts postgres-planned "$run_root"
  database_id="$(timeout --signal=TERM --kill-after=5s 1m docker run --detach --pull=never --name "$database_container" \
    --label "daynight.api-integration=$(basename "$run_root")" \
    --cpus=1 --memory=1g --memory-swap=1g \
    -e POSTGRES_USER=daynight -e POSTGRES_PASSWORD=daynight -e POSTGRES_DB=daynight \
    -p 127.0.0.1::5432 postgres:18.6-bookworm)"
  node scripts/integration-runtime.mts postgres "$run_root" "$database_id" "$database_container"
  ready=false
  ready_deadline=$((SECONDS + 20))
  while (( SECONDS < ready_deadline )); do
    if timeout --signal=TERM --kill-after=2s 2s docker exec "$database_id" pg_isready -h 127.0.0.1 -U daynight -d daynight >/dev/null 2>&1; then ready=true; break; fi
    sleep 0.1
  done
  if [[ "$ready" != true ]]; then
    timeout --signal=TERM --kill-after=2s 5s docker logs "$database_id" >&2
    printf '%s\n' 'Integration PostgreSQL did not become ready' >&2
    exit 1
  fi
  database_port="$(timeout --signal=TERM --kill-after=2s 5s docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$database_id")"
  export DAYNIGHT_TEST_DATABASE_URL="postgres://daynight:daynight@127.0.0.1:$database_port/daynight?sslmode=disable"
fi

race=true
if [[ -n "${CI:-}" ]] && [[ "${GITHUB_EVENT_NAME:-}" != push || "${GITHUB_REF:-}" != refs/heads/main ]]; then race=false; fi

decoder_source_fingerprint() {
  DAYNIGHT_INTEGRATION_REPOSITORY="$repository_root" node --input-type=module <<'JS'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const root = process.env.DAYNIGHT_INTEGRATION_REPOSITORY;
const names = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "packages/daynight", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]).toString().split("\0").filter(Boolean).sort();
const hash = createHash("sha256");
for (const name of names) {
  hash.update(name).update("\0");
  try { hash.update(readFileSync(join(root, name))); }
  catch (error) { if (error.code !== "ENOENT") throw error; hash.update("<deleted>"); }
  hash.update("\0");
}
process.stdout.write(hash.digest("hex"));
JS
}
node scripts/integration-runtime.mts phase "$run_root" build
decoder_source_before="$(decoder_source_fingerprint)"
decoder_head="$(git rev-parse HEAD)"
timeout --signal=TERM --kill-after=5s 3m pnpm --dir "$repository_root" --filter @codetreker/daynight build
timeout --signal=TERM --kill-after=5s 1m node "$repository_root/packages/daynight/scripts/package-image-validation.ts" "$run_root/image-validator"
if [[ "$decoder_source_before" != "$(decoder_source_fingerprint)" || "$decoder_head" != "$(git rev-parse HEAD)" ]]; then
  printf '%s\n' 'Image decoder sources changed during its build' >&2
  exit 1
fi
export DAYNIGHT_INTEGRATION_IMAGE_DECODER_DIR="$run_root/image-validator"
export DAYNIGHT_INTEGRATION_NODE_PATH="$(node -p 'process.execPath')"

fingerprint() {
  DAYNIGHT_INTEGRATION_REPOSITORY="$repository_root" node --input-type=module <<'JS'
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
const root = process.env.DAYNIGHT_INTEGRATION_REPOSITORY;
const names = new Set(execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "packages/daynight-server", "packages/daynight-web", "packages/daynight", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]).toString().split("\0").filter(Boolean));
const assets = join(root, "packages/daynight-server/internal/service/webui/dist");
for (const entry of readdirSync(assets, { recursive: true, withFileTypes: true })) {
  if (entry.isFile()) names.add(relative(root, join(entry.parentPath, entry.name)));
}
const hash = createHash("sha256");
for (const name of [...names].sort()) {
  hash.update(name).update("\0");
  try { hash.update(readFileSync(join(root, name))); }
  catch (error) { if (error.code !== "ENOENT") throw error; hash.update("<deleted>"); }
  hash.update("\0");
}
const decoder = process.env.DAYNIGHT_INTEGRATION_IMAGE_DECODER_DIR;
for (const entry of readdirSync(decoder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))) {
  const file = join(entry.parentPath, entry.name);
  hash.update(relative(decoder, file)).update("\0").update(readFileSync(file)).update("\0");
}
process.stdout.write(hash.digest("hex"));
JS
}

node scripts/integration-runtime.mts phase "$run_root" build
source_sha="$(git rev-parse HEAD)"
before="$(fingerprint)"
GOFLAGS= timeout --signal=TERM --kill-after=5s 5m go build -race="$race" -p=2 -trimpath -o "$run_root/server" ./cmd/daynight-server
GOFLAGS= timeout --signal=TERM --kill-after=5s 5m go build -race="$race" -p=2 -trimpath -tags=integration -o "$run_root/cleanup" ./cmd/integration_tests
after="$(fingerprint)"
if [[ "$before" != "$after" || "$source_sha" != "$(git rev-parse HEAD)" || "$decoder_head" != "$source_sha" || "$decoder_source_before" != "$(decoder_source_fingerprint)" ]]; then
  printf '%s\n' 'Product sources changed while the integration binaries were built' >&2
  exit 1
fi
node scripts/integration-runtime.mts cleanup-binary "$run_root"
node scripts/integration-runtime.mts receipt "$run_root" "$source_sha" "$before" "$race"

node scripts/integration-runtime.mts phase "$run_root" runtime
GOFLAGS= timeout --signal=TERM --kill-after=5s 1m go test -race="$race" -p=2 -count=1 -timeout=45s -tags=integration -run '^TestIntegrationSchemaCleanup$' -v ./cmd/integration_tests

node scripts/integration-runtime.mts phase "$run_root" authentication
DAYNIGHT_TEST_UNIAUTH_FIXTURE="$(node scripts/prepare-uniauth-fixture.mts)"
export DAYNIGHT_TEST_UNIAUTH_FIXTURE
node scripts/integration-runtime.mts auth "$run_root" "$DAYNIGHT_TEST_UNIAUTH_FIXTURE"
export DAYNIGHT_INTEGRATION_SERVER_BINARY="$run_root/server"
node scripts/integration-runtime.mts phase "$run_root" test
GOFLAGS= timeout --signal=TERM --kill-after=5s 5m go test -race="$race" -p=2 -count=1 -timeout=4m -tags=integration -run '^(TestServerAPINormalFlows|TestServerAPISessionNormalFlow|TestServerAPICredentialUsageNormalFlow)$' -v ./cmd/integration_tests
