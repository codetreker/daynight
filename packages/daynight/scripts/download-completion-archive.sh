#!/usr/bin/env bash
set -euo pipefail

if (( $# < 3 )) || [[ ! "$2" =~ ^[0-9a-f]{64}$ ]]; then
  printf '%s\n' 'Usage: download-completion-archive.sh <archive> <sha256> <https-url>...' >&2
  exit 2
fi
archive="$1"
checksum="$2"
shift 2

valid_archive() {
  printf '%s  %s\n' "$checksum" "$1" | sha256sum --check --status
}

if [[ -f "$archive" ]] && valid_archive "$archive"; then
  exit 0
fi

# Only a verified complete download may become the reusable archive.
temporary="$(mktemp "${archive}.part.XXXXXX")"
trap 'rm -f -- "$temporary"' EXIT
for url in "$@"; do
  : > "$temporary"
  if curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
      --connect-timeout 15 --max-time 120 --output "$temporary" "$url" && valid_archive "$temporary"; then
    mv -f -- "$temporary" "$archive"
    exit 0
  fi
  printf 'Unable to verify archive from %s.\n' "$url" >&2
done
printf '%s\n' 'All completion toolchain archive sources failed verification.' >&2
exit 1
