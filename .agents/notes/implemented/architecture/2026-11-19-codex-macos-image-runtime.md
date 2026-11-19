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

## Decision

[`supportsCodexImageProfile`](../../../../packages/daynight/src/commands/controller/providers/codex-image-profile.ts)
also recognizes `daynight/0.170.0` when the native process reports `platformOs`
`macos` and the Controller runs on `darwin`. The entry is exact: other 0.170
patch versions, other platforms and a mismatched native/Controller platform
remain unrecognized.

Recognition is protocol compatibility only. It does not qualify any model or
backend. Admission still requires a production qualification row that matches
the complete runtime identity, the service capability intersection and the
history admission described in the
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

## Consequences

Each future Codex release needs its own explicit compatibility entry and fresh
evidence before it can be qualified. A Codex update to another version returns
its Sessions to `profile_disabled`, which is the intended failure mode. The
[declared configuration observation](2026-11-16-codex-image-config-observation.md)
and its new-thread-only scope are unchanged.
