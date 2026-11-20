# Agent Note: Narrow Project Heading Menu

Status: implemented

## Problem

Four project actions occupy valuable heading space on narrow screens. Long
translations and larger text make even a compact row wrap and push the section
navigation down, while each action must retain its existing admission and form
behavior.

## Decision

At a heading content width of 420 CSS px or less, a single 44px ellipsis opens
the available settings, refresh, Task creation and Goal creation actions in
order. Wider headings retain direct text actions. The menu uses a top-layer
popover positioned within the viewport and provides keyboard navigation and
focus restoration. Settings remains a native link; refresh and creation retain
their existing controllers and permission boundaries. The creation forms and
drafts outlive changes to the menu and responsive presentation. The
[specification](../../../../docs/spec/daynight-web.md#项目分区导航) owns the
observable interaction contract.

## Alternatives

**Keep the compact action row.** The [earlier decision](../../archived/bug-fix/2026-11-20-project-heading-actions.md)
reduced the normal 320px case to one row, but larger text and longer labels
still consume additional heading space.

**Use a viewport breakpoint.** The heading may be narrow within a wider
workspace, so viewport width does not represent its available content width.

## Consequences

The heading has one touch target at narrow widths and preserves complete menu
labels. Actions require an additional interaction, and the menu must handle
viewport constraints, keyboard access, focus handoff and permission changes.
The independent Project read still determines whether settings is available.
