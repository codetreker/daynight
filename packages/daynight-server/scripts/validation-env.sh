#!/usr/bin/env bash

source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
cd -- "$DAYNIGHT_MODULE_ROOT"
: "${DAYNIGHT_TEST_DATABASE_URL:?Set DAYNIGHT_TEST_DATABASE_URL to an isolated PostgreSQL test database}"

unset COVERPROFILE MODULE_PREFIX PROJECT_NAME HTML_OUT THRESHOLD_FUNC \
  THRESHOLD_PACKAGE THRESHOLD_PRINT THRESHOLD_TOTAL UNCOVERED_LIMIT \
  EXCLUDE_PACKAGES SKIP_RESULT_PACKAGES EXCLUDE_FILES EXCLUDE_FUNCS \
  EXCLUDE_FUNC_SUFFIXES TEST_TIMEOUT BUILD_TAGS GENERATE_HTML \
  RACE_DETECTION FAIL_ON_CRITICAL_BLOCKS

race=true
if [[ -n "${CI:-}" ]] && [[ "${GITHUB_EVENT_NAME:-}" != push || "${GITHUB_REF:-}" != refs/heads/main ]]; then
  race=false
fi

# Both coverage owners and nested service builds resolve the same fixed Web
# resources, including when go-cov executes from the command directory.
node --input-type=module - "$DAYNIGHT_MODULE_ROOT" <<'JS' > .tmp/unit-overlay.json
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = process.argv[2];
const overlay = JSON.parse(readFileSync(resolve(root, "scripts/unit-overlay.json"), "utf8"));
const Replace = Object.fromEntries(Object.entries(overlay.Replace).map(([source, target]) => [
  resolve(root, source), resolve(root, target),
]));
process.stdout.write(JSON.stringify({ Replace }));
JS

# Explicit final flags preserve the validation policy despite inherited flags.
unit_go_flags="${GOFLAGS:+$GOFLAGS }-p=2 -overlay=$DAYNIGHT_MODULE_ROOT/.tmp/unit-overlay.json -tags= -race=$race"
