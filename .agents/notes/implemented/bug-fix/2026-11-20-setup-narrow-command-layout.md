# Agent Note: Narrow Setup Command Layout

Status: implemented

## Problem

At a 320px viewport, the setup step number occupies a full-height column while
the remaining command width forces a short command's copy button onto a second
line. The empty number column and extra line make both setup paths harder to scan.

## Decision

At a step-list inline width of 324px or less, place the number beside the title
and let the remaining step content span both columns. A command uses a flexible
code track and a 32px copy track with an 8px gap, aligned at the top. Wider
steps retain the existing column and command arrangement. The shared copy
lifecycle and selectable command text remain unchanged. The
[Web requirements](../../../../docs/spec/daynight-web.md#日常使用引导) own the
observable behavior and the [design](../../../../docs/design/daynight-web.md#日常使用引导页)
owns the layout.

## Alternatives

**Only shrink the command flex basis.** This keeps the empty number column beside
the entire description and reduces the space available for long commands.

## Consequences

The breakpoint follows the available step width rather than the viewport, so
embedded or resized guide panels receive the same treatment. The wider copy
target consumes space in the command but retains code width at 320px by using
the former number column.
