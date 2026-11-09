#!/usr/bin/env bash
set -euo pipefail
repository_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$repository_dir"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$repository_dir/.tmp/playwright-browsers}"
export DAYNIGHT_SEARCH_SOURCE_HASH
DAYNIGHT_SEARCH_SOURCE_HASH="$(node packages/daynight-web/scripts/acceptance/task-search.mts --fingerprint)"
timeout 1500 node packages/daynight-web/scripts/acceptance/task-search-local.mts
