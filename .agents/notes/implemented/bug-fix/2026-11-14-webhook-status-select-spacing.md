# Agent Note: Webhook Status Select Spacing

Status: implemented

## Problem

The endpoint status filter's browser-drawn arrow can sit unevenly or too close
to the border. Its position is independent of text padding, while the control
must keep its native interaction and fit beside search at narrow widths.

## Decision

The endpoint status select uses a scoped wrapper and noninteractive, symmetric
chevron with a fixed right inset. The select reserves text space for the arrow
and remains native. The wrapper stretches with the search field and retains the
Webhook control's own responsive sizing. The team selector shares the generic
filter class but does not use this decoration.

The [Worker configuration select decision](2026-11-06-worker-configuration-select-spacing.md)
records the same native-control trade-off for a separate set of fields; the
[task-list filter decision](../feature/2026-11-05-task-list-status-filter.md)
owns the related chevron on task filters. The [Webhook specification](../../../../docs/spec/webhook-web.md)
owns observable behavior and the [design](../../../../docs/design/webhook-web.md)
owns layout and validation.

## Alternatives

**Keep the browser arrow and adjust text padding.** Browsers position the arrow
independently, so text padding cannot ensure a consistent right inset.

**Apply the existing task-filter dimensions or decorate every filter.** The
Webhook toolbar has its own responsive height and width, and the shared filter
class also belongs to the team selector; either approach would change unrelated
control geometry.

## Consequences

The status control keeps the native menu, keyboard and focus behavior while its
arrow placement is consistent. The reserved space reduces available text width,
so both languages and narrow viewports need browser geometry and interaction
checks. The browser continues to own the native menu's appearance.
