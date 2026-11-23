# Agent Note: Separate narrow discussion actions from author wrapping

Status: implemented

## Problem

At phone widths, adjacent reply and message-details controls were each 22×22
CSS px with no gap. Their small, touching targets made the two actions difficult
to distinguish by touch. Longer author names, provider badges and full account
labels also compete with the controls for the same message-header width.

## Decision

The shared Discussion timeline groups the author, optional provider badge and
short time separately from the reply and details controls. At viewport widths
up to 600px, the identity group shrinks and wraps within its own column. The
actions remain together at the trailing edge, with two actual 30×30 CSS px
buttons separated by 4px. Message text keeps the full main-column width below
the header; avatar geometry and timeline padding retain their existing sizes.

Above 600px the identity wrapper uses `display: contents`, so the existing header
flex items retain their wrapping, 25×25 CSS px controls, 2px gap and hover/focus
visibility. The wrapper changes presentation only; existing control handlers and
accessible names continue to own reply focus and message-details navigation.
The [Web design](../../../../docs/design/task-thread-web.md#阅读键盘与验证)
owns the complete layout and interaction rules.

## Alternatives

**Enlarge the controls within the existing wrapping header.** This makes each
target easier to hit but lets long identity text push the actions onto a separate
header row. Reserving an independent action column keeps their location stable
while the author text grows.

**Use the grouped identity layout at every width.** This would also change how
desktop headers wrap long author text. `display: contents` above the narrow
breakpoint preserves the established desktop geometry while allowing the
phone layout to reserve space for its larger controls.

## Consequences

Phone headers can grow vertically for long names and full account labels while
retaining both actions on one row. The additional header space is intentional;
body reading width and controller behavior remain unchanged. The shared
component applies the geometry consistently to Task and Goal discussions in
page, modal and fullscreen detail surfaces. CSS dimensions alone do not prove
touch dispatch or dialog focus restoration; those require browser interaction
checks at both sides of the breakpoint.
