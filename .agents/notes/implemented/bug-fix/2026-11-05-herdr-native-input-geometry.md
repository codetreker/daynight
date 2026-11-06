# Agent Note: Direct macOS Herdr Input Geometry

Status: implemented

## Problem

Input readiness queried the original shell's TTY with `ps` and its dimensions
with `stty`, repeating both checks before each input frame. During real Claude
input, a complete paste was written but repeated readiness checks consumed the
10-second batch deadline before Enter. The original result correctly remained
unknown. A separate Codex size query failed before any write; the retained
error did not establish its child signal or exact failure cause.

## Decision

Replace the external-command implementation of the
[input arbitration decision](../../archived/architecture/2026-11-04-herdr-input-arbitration.md)
with a dedicated macOS helper using the existing Koffi dependency and system
library. The helper reads the original PID's controlling terminal device from
`PROC_PIDTBSDINFO`, resolves it with `devname_r`, and accepts only the supported
numbered PTY names. A short record, different PID, missing controlling terminal,
or unsupported device cannot authorize input.

The helper opens the PTY read-only with no-controlling-terminal, nonblocking,
and no-follow flags. It verifies the descriptor is a character device and calls
only `TIOCGWINSZ`, closing the descriptor in every success, failure and
cancellation path. Darwin SDK headers and a native layout probe establish the
structure offsets, constants and function signatures, including variadic ioctl
calling conventions. The [input design](../../../../docs/design/herdr-input-arbitration.md)
owns the current geometry and admission contract.

Both topology observations, the original process proof, readiness, authorization,
per-frame admission and the existing batch deadline remain required. A failed
query supplies no guessed size. Failures after a native write remain unknown
and cannot authorize replay.

## Alternatives

**Increase the command timeout or batch deadline.** This retains repeated process
startup costs and still permits exhaustion between paste and Enter. The direct
read removes that cost without expanding the period of uncertain execution.

**Skip the second observation or reuse an earlier dimension.** This loses proof
that the current target and actual PTY geometry still match before input.

**Infer dimensions from the layout.** Borders and other UI geometry do not
establish the PTY's actual rows and columns.

## Consequences

Input geometry no longer requires a child process. macOS ABI details become
an explicit implementation dependency and require revalidation if the supported
platform contract changes. This removes command-startup overhead, not every
possible source of a slow or cancelled batch. Transport completion still does
not establish provider acceptance, and strict attach retains its existing
geometry and pending-agent side effects.
