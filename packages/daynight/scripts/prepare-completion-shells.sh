#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_directory/../../.." && pwd)"
toolchain_directory="$repository_root/.tmp/shell-completion"
downloads="$toolchain_directory/downloads"
bash_source="$toolchain_directory/toolchains/bash-4.2"
bash_install="$toolchain_directory/toolchains/bash-4.2-install"
bash_archive="$downloads/bash-4.2.tar.gz"
bash_checksum=a27a1179ec9c0830c65c6aa5d7dab60f7ce1a2a608618570f96bfa72e95ab3d8

if [[ "$(uname -s)" != Linux ]]; then
  printf '%s\n' 'Completion toolchain preparation requires Linux; select existing shell executables on other POSIX hosts.' >&2
  exit 1
fi

mkdir -p "$downloads" "$toolchain_directory/toolchains"

# We exercise the unpatched GNU release to verify the declared Bash 4.2 minimum.
if [[ ! -x "$bash_install/bin/bash" ]]; then
  bash "$script_directory/download-completion-archive.sh" "$bash_archive" "$bash_checksum" \
    https://ftp.gnu.org/gnu/bash/bash-4.2.tar.gz \
    https://mirrors.kernel.org/gnu/bash/bash-4.2.tar.gz \
    https://mirrors.ibiblio.org/gnu/bash/bash-4.2.tar.gz
  if [[ -e "$bash_source" ]]; then
    printf '%s\n' 'An incomplete Bash source tree exists; remove .tmp/shell-completion/toolchains/bash-4.2 before preparing again.' >&2
    exit 1
  fi
  tar -xzf "$bash_archive" -C "$toolchain_directory/toolchains"
  (
    cd "$bash_source"
    timeout 120 ./configure --without-bash-malloc --prefix="$bash_install"
    timeout 300 make bash
  )
  mkdir -p "$bash_install/bin"
  cp "$bash_source/bash" "$bash_install/bin/bash"
fi
"$bash_install/bin/bash" -c '[[ ${BASH_VERSINFO[0]} == 4 && ${BASH_VERSINFO[1]} == 2 ]]'

DAYNIGHT_TEST_BASH42="$bash_install/bin/bash"
DAYNIGHT_TEST_BASH="$(command -v bash)"
DAYNIGHT_TEST_ZSH_ROOT=''
if command -v zsh >/dev/null 2>&1; then
  DAYNIGHT_TEST_ZSH="$(command -v zsh)"
else
  DAYNIGHT_TEST_ZSH_ROOT="$toolchain_directory/toolchains/zsh"
  DAYNIGHT_TEST_ZSH="$DAYNIGHT_TEST_ZSH_ROOT/bin/zsh"
  if [[ ! -x "$DAYNIGHT_TEST_ZSH" ]]; then
    (
      cd "$downloads"
      timeout 120 apt-get download zsh zsh-common
      for package in zsh_*.deb zsh-common_*.deb; do
        dpkg-deb --extract "$package" "$DAYNIGHT_TEST_ZSH_ROOT"
      done
    )
  fi
fi
"$DAYNIGHT_TEST_ZSH" --version

environment_file="$toolchain_directory/environment.sh"
printf 'export DAYNIGHT_TEST_BASH42=%q\nexport DAYNIGHT_TEST_BASH=%q\nexport DAYNIGHT_TEST_ZSH=%q\nexport DAYNIGHT_TEST_ZSH_ROOT=%q\n' \
  "$DAYNIGHT_TEST_BASH42" "$DAYNIGHT_TEST_BASH" "$DAYNIGHT_TEST_ZSH" "$DAYNIGHT_TEST_ZSH_ROOT" > "$environment_file"
if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'DAYNIGHT_TEST_BASH42=%s\nDAYNIGHT_TEST_BASH=%s\nDAYNIGHT_TEST_ZSH=%s\nDAYNIGHT_TEST_ZSH_ROOT=%s\n' \
    "$DAYNIGHT_TEST_BASH42" "$DAYNIGHT_TEST_BASH" "$DAYNIGHT_TEST_ZSH" "$DAYNIGHT_TEST_ZSH_ROOT" >> "$GITHUB_ENV"
fi
printf 'Shell toolchains are ready. For local acceptance: source %q && pnpm completion:acceptance\n' "$environment_file"
