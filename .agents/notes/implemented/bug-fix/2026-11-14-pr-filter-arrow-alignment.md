# Agent Note: PR Filter Arrow Alignment

Status: implemented

## Problem

The browser-drawn arrow in the PR status filter can appear uneven and close to
its border. Its placement is controlled independently of the select's text
padding, so the existing spacing cannot ensure a consistent inset.

## Decision

The original PR filter retained its native select and drew a noninteractive,
symmetric SVG chevron in a positioned wrapper, with a 12px right inset and
explicit desktop and narrow heights. The [shared native select decision](../architecture/2026-11-14-shared-native-select.md)
now owns this presentation: the PR filter uses its 32px filter variant and
keeps its responsive full-width layout. The [PR workspace
read design](../../../../docs/design/github-pr-reading.md) owns its filtering
and reading behavior.

## Alternatives

**Keep the browser arrow and adjust padding.** Padding does not control the
browser's arrow placement or guarantee its distance from the border.

**Replace the select with a custom menu.** A visual correction does not justify
reimplementing native selection, keyboard, focus and disabled behavior.

## Consequences

The arrow has stable shared geometry. The control's natural width excludes
the browser's native arrow slot, while the responsive full-width layout remains. Browser tests cover the scoped
geometry and native interaction alongside the workspace's reading behavior.
