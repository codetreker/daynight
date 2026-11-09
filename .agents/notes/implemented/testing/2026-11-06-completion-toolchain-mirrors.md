# Agent Note: Completion Toolchain Mirrors

Status: implemented

## Problem

The real-shell completion check needs the original Bash 4.2 release, but a
single archive host can fail before the test starts. A partial cached download
must not prevent later attempts or be accepted as a toolchain.

## Decision

The Linux preparation helper tries the GNU archive followed by the Kernel.org
and ibiblio GNU mirrors. Each HTTPS download uses a temporary file and must
match the existing SHA-256 pin before replacing the cached archive. An existing
cache is checked before use. Failure of every source stops preparation; the
real-shell acceptance suite still requires Bash 4.2, modern Bash and zsh.

GNU lists both mirrors in its [mirror directory](https://www.gnu.org/prep/ftp.html).
The [original completion decision](../../archived/feature/2026-10-20-shell-completion.md)
records the shell support and real-terminal rationale.

## Alternatives

**One host with retries.** Repeated connections to the same unavailable host
cannot recover from an independent host or network outage.

**Replace Bash 4.2 with a newer shell.** This would leave the declared minimum
without the real-shell acceptance coverage it requires.

## Consequences

Preparation can continue when one archive endpoint fails or supplies corrupt
bytes, while the checksum remains authoritative for every source. A first run
still needs a reachable mirror and the existing build tools; failures remain
visible when none provides the pinned release.
