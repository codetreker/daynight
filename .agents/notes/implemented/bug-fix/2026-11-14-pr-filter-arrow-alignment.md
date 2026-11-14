# Agent Note: PR Filter Arrow Alignment

Status: implemented

## Problem

The browser-drawn arrow in the PR status filter can appear uneven and close to
its border. Its placement is controlled independently of the select's text
padding, so the existing spacing cannot ensure a consistent inset.

## Decision

The PR filter retains its native select and draws a noninteractive, symmetric
SVG chevron in its own positioned wrapper. The control reserves its existing
right padding for the arrow, which is centered vertically with a 12px right
inset. Explicit desktop and narrow heights preserve the control's measured
native dimensions after removing the browser appearance. The [PR workspace
read design](../../../../docs/design/github-pr-reading.md) owns its filtering
and reading behavior.

## Alternatives

**Keep the browser arrow and adjust padding.** Padding does not control the
browser's arrow placement or guarantee its distance from the border.

**Replace the select with a custom menu.** A visual correction does not justify
reimplementing native selection, keyboard, focus and disabled behavior.

## Consequences

The arrow has stable geometry without changing other selects. The control's
natural width no longer includes the browser's native arrow slot, while the
existing responsive full-width layout remains. Browser tests cover the scoped
geometry and native interaction alongside the workspace's reading behavior.
