# Agent Note: Codex 0.170.0 on macOS becomes an image-qualifiable runtime

Status: implemented

[Default image send](2026-11-24-default-session-image-send.md) changes ordinary Codex and Copilot
admission. The decision below records the original exact-qualification
policy and its evidence. Runtime observations and applicable tighter
limits still inform current capabilities.

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

Once identity is observable, the production registry still has to say which
exact combinations are admitted and with which limits. A row that is broader
than its evidence would admit inputs nobody has seen the native runtime and
model consume correctly.

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

The production
[registry](../../../../packages/daynight/src/commands/controller/providers/image-qualification.ts)
contains one row per evidenced model: Codex 0.170.0 on `darwin`/`arm64`, the
native binary digest `9248cfee…abd6`, `sdkVersion` null, the declared
`copilot_gateway` route digest `63f0adb3…b8bc14`, and model `gpt-6-astra` or
`gpt-6.2-astra`. Each row grants `send` only; `steer` stays false because no
same-turn steer receipt was collected. Its limits are the largest values the
native evidence actually delivered and the model answered correctly: PNG, JPEG
and WebP; eight images per message; 16384 pixels wide or high; 33554432 pixels;
one frame; and per-model byte limits of 10461350 / 20904114
(`gpt-6-astra`) and 10442582 / 20883253 (`gpt-6.2-astra`) for one image and a
whole message. `evidenceId` names the native evidence package attached to the
owning Daynight task and `evidenceSha256` pins its bytes; the package records
the probe, generator, grader, raw results and identity readback. That package
is native app-server evidence only: it fixes identity, limits and the steer
decision but is not product-chain acceptance. The acceptance specification
still requires product evidence for the same combination (upload, native
delivery, model answer, history, preview, download, archive and reading the
original after the Controller stops); that evidence lives in the combination's
acceptance report rather than in the row, and the rows ship only after it
passes.

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

**Qualify the model family or any backend for this binary.** Both models
share the route digest, but the evidence is per model and the route digest only
covers declared configuration. A model-agnostic row would admit models whose
image handling was never observed.

**Publish `IMAGE_LIMITS` or catalog limits instead of evidenced values.** The
byte limits observed are slightly below the product limits; publishing the
product values would claim sizes no sample covered. The difference is a few
tens of kilobytes, so the evidenced values cost users almost nothing. Frames
stay at one because no animated sample was sent.

**Enable steer alongside send.** No evidence shows that an image submitted
into an active turn is received in that same turn without implicit queueing,
so steer remains closed until such a receipt exists.

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

The two rows close whenever any identity field changes. A Codex self-update
to another version returns Sessions to `profile_disabled`; a rebuilt or
reinstalled 0.170.0 binary, another platform or architecture, a changed
declared route or another model returns them to `capability_unknown`. Each
case needs fresh evidence and a new row. JPEG and WebP were sampled only at
small sizes; the rows still express one limit set per model.

The [declared configuration observation](2026-11-16-codex-image-config-observation.md)
and its new-thread-only scope are unchanged, so resumed threads establish no
observation and stay `capability_unknown`. Copilot keeps no production row: on
macOS its Web Sessions run through a materialized runtime whose identity the
current design keeps unknown.
