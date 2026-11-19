# Agent Note: Codex 0.170.0 on macOS becomes an image-qualifiable runtime

Status: implemented

## Problem

Image input requires an exact qualified runtime combination, and the Codex
Provider first checks that the native app-server speaks a protocol version known
to carry ordered `localImage` input. That check recognized macOS 0.167.0 and
Windows 0.169.0 only. Current macOS installations run Codex 0.170.0, so every
macOS Codex Session reported `profile_disabled` before qualification could even
be considered. Native experiments on 0.170.0 / macOS arm64 already showed
correct pure-image and image-with-text answers with one `turn/start` per case,
but no registry row can match a runtime the compatibility gate refuses.

A qualification row also binds the native executable sha256. The Codex Provider
derived that digest only on Windows, from a verified direct `.exe` entry, so a
macOS runtime always reported an unknown executable identity and still could
not match any row even after protocol recognition.

## Decision

[`supportsCodexImageProfile`](../../../../packages/daynight/src/commands/controller/providers/codex-image-profile.ts)
also recognizes `daynight/0.170.0` when the native process reports `platformOs`
`macos` and the Controller runs on `darwin`. The entry is exact: other 0.170
patch versions, other platforms and a mismatched native/Controller platform
remain unrecognized.

[`codexExecutableDigest`](../../../../packages/daynight/src/commands/controller/providers/codex-config-observation.ts)
returns the artifact sha256 for a verified direct native entry on `darwin` as
well as for a direct `.exe` on `win32`. Every other condition is shared and
unchanged: the launch is the frozen Codex Web launch, it has no interpreter,
prefix arguments or runtime profile, the spawned file equals its
`executablePath`, and exactly one `entry` or `runtime` artifact has that real
path. On macOS a direct entry is identified by its Mach-O header without
executing it, and `executablePath` is the realpath, so a symlinked launcher such
as `~/.local/bin/codex` yields the digest of the real binary. npm installations
that start Codex through a Node script remain interpreter launches with an
unknown digest. Linux remains unknown.

Recognition and the digest establish identity only. They do not qualify any
model or backend. Admission still requires a production qualification row that
matches the complete runtime identity, the service capability intersection and
the history admission described in the
[qualification boundary decision](2026-11-16-image-qualification-boundaries.md).
With no matching row, a recognized 0.170.0 Session reports `capability_unknown`
instead of `profile_disabled`; images stay closed and text input is unaffected.

## Alternatives

**Accept a version range such as `>=0.167.0`.** Codex changes its app-server
protocol between releases, and the existing design treats each version as a
separately recognized entry. A range would silently admit untested releases into
the identity path.

**Keep 0.167.0 only and pin users to it.** Codex updates itself, and current
installations no longer run 0.167.0, so macOS image input would stay unavailable.

**Digest the entry path selected from PATH instead of the resolved native
file.** For a symlinked launcher the entry path names the link, while the
process executes its target; hashing anything other than the verified realpath
would bind qualification to a file that is not the running program. Interpreter
launches were also excluded, because the Node script's digest says nothing
about the native binary it later spawns from its own package.

## Consequences

Each future Codex release needs its own explicit compatibility entry and fresh
evidence before it can be qualified. A Codex update to another version returns
its Sessions to `profile_disabled`, which is the intended failure mode.

The macOS digest makes the qualification exact to one binary build. A Codex
self-update, reinstall or Homebrew upgrade that changes the binary bytes changes
the digest, so a matching row stops matching and images close until a row for
the new build is qualified; a frozen launch whose files changed also fails
verification as `tool_identity_changed`. The digest is taken after
`verifyToolLaunch` and before spawn, so a replacement in that short window is
not detected; this is the same bounded check already accepted for Windows.

The [declared configuration observation](2026-11-16-codex-image-config-observation.md)
and its new-thread-only scope are unchanged.
