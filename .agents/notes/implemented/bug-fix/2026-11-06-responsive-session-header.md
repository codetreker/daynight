# Agent Note: Responsive Session Header

Status: implemented

## Problem

The default Session header wrapped its identity and action groups independently.
In a narrow Test Session, this placed a short provider and status at the left of
one row and actions at the right of another, leaving both rows partly empty.
Long activity labels could add a third row and reduce the timeline's available
height. Task panels and Session fullscreen have different available widths, so
viewport width alone cannot select a suitable layout.

## Decision

The default Session section establishes a named inline-size container. Below
480px, its header uses a provider/action row followed by a full-width status row.
Below 260px, provider, status and actions each have a row. Desktop keeps the
existing flex layout. Only the provider text can ellipsize; its complete text
remains accessible. Status text can wrap without clipping.

The same refresh button changes from text to a 36px icon in narrow containers,
with a localized accessible name and hover/focus hint. The fullscreen button
uses the same size there. Neither control's handlers, permission gates nor
identity depend on width. Custom header slots retain their original presentation
and do not receive the default layout container or icon refresh control.

The [Session requirements](../../../../docs/spec/task-sessions.md#session-默认头部)
own the visible behavior and the [Session design](../../../../docs/design/task-session-protocol.md#默认头部布局)
owns the component and CSS mechanisms.

## Alternatives

**Keep independently wrapping flex groups.** Reducing gaps or button padding
cannot reliably place the provider beside actions while giving long statuses a
complete row. It also makes row placement depend on the provider and locale.

**Use viewport breakpoints.** A narrow Task panel on a wide screen would retain
the problematic layout, while fullscreen changes the available width without
changing the viewport. A container query follows the Session's actual budget.

## Consequences

Narrow headers have predictable semantic rows and keep controls reachable.
This saves height where the old groups wrapped separately; a short header that
previously fitted on one row can instead use two rows. Very narrow containers
use three rows intentionally. Full status labels may increase a row's height.
Browser geometry must therefore verify the row relationship and controls, not
assume one fixed height for all labels and entry points.

The default layout is isolated from custom presentations. The outer page spacing,
Chatbox, display menu, fullscreen ownership and Provider lifecycle remain owned
by their existing components.
