# Agent Note: Task Claim Phase Size

Status: implemented

## Problem

The read-only execution phase in a Task's current claim has the same visual
weight as the adjacent machine and Agent information. Its auxiliary role is
harder to distinguish in the shared detail presentation.

## Decision

The shared Task detail claim phase badge uses `--text-metadata`, while adjacent
claim information retains `--text-interface`. This applies to every execution
phase in the dialog, standalone page and fullscreen presentation. The
[Web specification](../../../../docs/spec/daynight-web.md) owns the visible
contract; this refines the status mapping in the
[semantic typography decision](../architecture/2026-11-20-web-semantic-typography.md).

## Alternatives

**Keep the interface role for the phase.** It gives the read-only phase the same
prominence as the neighboring claim information and obscures their hierarchy.

**Restore a fixed pixel size.** A fixed size would stop the badge scaling with
the browser's root font preference and bypass the shared typography roles.

## Consequences

The phase remains legible as secondary information and scales with browser font
preferences. Phase labels, colors and claim operations retain their existing
behavior; browser validation remains necessary for wrapping and visibility.
