# Agent Note: Session Reading Column Alignment

Status: implemented

## Problem

The Session timeline centers a bounded reading column while the Chatbox stretches
across its panel. Separate scrollports make matching maximum widths insufficient:
classic scrollbars consume horizontal space only inside the timeline. Assistant
presentations also have their own reading width and side spacing.
Narrow input columns can also expose a zero-basis timeline allocation: a long
command menu consumes all reading space even though the menu can shrink.

## Decision

The rendered timeline content is the single source for the input column.
`useSessionColumnLayout` measures its left and right edges relative to the
composer's inner border and applies those distances as the form's horizontal
padding. The existing default and assistant reading limits remain in their
respective timeline styles. The form's settings, command panel, attachments and
Chatbox surface consequently share the same width without another wrapper.

The timeline has a shrinkable 100px flex basis so it shares space with expanded
composer panels instead of yielding its entire content area. Its zero minimum
height remains available for exceptionally short panels. This extends the
[command menu layout](../../archived/bug-fix/2026-11-04-session-command-menu.md)
without changing menu scroll ownership or measured control minima.

Initial measurement runs in a layout effect. Resize observations of the Session,
timeline viewport and content schedule a frame to update the distances, including
when scrollbar occupancy changes. Zero-width hidden content is ignored until it
becomes measurable. Identity changes and removal cancel pending work and remove
the measured properties. The [Session design](../../../../docs/design/task-session-protocol.md)
owns the mechanism and the [requirements](../../../../docs/spec/task-sessions.md#chatbox-设置命令与运行状态)
own the alignment and interaction guarantees.

## Alternatives

**Give both elements the same maximum width.** A classic scrollbar still shifts
the centered timeline and reduces its available narrow width. Separate padding
rules also leave assistant presentations misaligned.

**Reserve matching scrollbar gutters on the composer.** Making the composer an
overflow container changes clipping or scroll ownership for panels and keyboard
hints. Measuring the existing column preserves those behaviors.

**Wrap the composer children in a bounded column.** The height budget inspects
the form's direct children to reserve controls and allow menus to shrink. A new
wrapper would require revising that mechanism for a horizontal alignment fix.

**Restore a fixed minimum timeline height.** This would preserve reading space
at the cost of pushing minimum input controls out of exceptionally short panels.
A shrinkable basis gives reading space a share without imposing that overflow.

## Consequences

Alignment includes actual borders, padding and either scrollbar placement without
changing Session keys, input handlers, scroll restoration or custom presentation
slots. It depends on browser layout and ResizeObserver; geometric browser tests
must exercise classic scrollbars as well as narrow and hidden containers. JSDOM
or prototype screenshots alone cannot establish alignment. A future independent
composer layout must retain the form-to-reading-column relationship or replace
the measurement owner deliberately.
