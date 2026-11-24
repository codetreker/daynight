#!/usr/bin/env bash
set -euo pipefail

module_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
package_dir="$(pwd -P)"
case "$package_dir" in
  "$module_root/internal/core/store/postgres/task") variable=DAYNIGHT_TEST_POSTGRES_TASK_URL ;;
  "$module_root/internal/core/store/postgres/github") variable=DAYNIGHT_TEST_POSTGRES_GITHUB_URL ;;
  "$module_root/internal/core/store/postgres/identity") variable=DAYNIGHT_TEST_POSTGRES_IDENTITY_URL ;;
  "$module_root/internal/core/store/postgres/session") variable=DAYNIGHT_TEST_POSTGRES_SESSION_URL ;;
  "$module_root/internal/core/store/postgres/worker") variable=DAYNIGHT_TEST_POSTGRES_WORKER_URL ;;
  "$module_root/internal/service/project") variable=DAYNIGHT_TEST_SERVICE_PROJECT_URL ;;
  "$module_root/internal/service/session") variable=DAYNIGHT_TEST_SERVICE_SESSION_URL ;;
  "$module_root/internal/service/mcpdownload") variable=DAYNIGHT_TEST_SERVICE_MCPDOWNLOAD_URL ;;
  *) exec "$@" ;;
esac

if [[ -z "${!variable:-}" ]]; then
  printf 'Missing %s for Go test package %s\n' "$variable" "$package_dir" >&2
  exit 1
fi
export DAYNIGHT_TEST_DATABASE_URL="${!variable}"
exec "$@"
