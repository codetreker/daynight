# Agent Note: Goal Description Tab

Status: implemented

## Problem

Goal description and child Task browsing shared a panel, so a long description
competed with the organization and task list for the same reading space. Readers
needed a clear way to reach each without losing their place or the existing Task
navigation and attachment behavior.

## Decision

The original separation placed Description before Tasks, Attachments and
Discussion, with Tasks selected by default and represented by `overview`.
Description used the existing Markdown reader and Goal attachment navigation.
Description and Tasks scrolled independently, and all four panels retained their
mounted state. Shared URL and page history navigation accepted `description`;
ordinary Task details normalized that Goal-only selection to Overview.

The [Goal detail information decision](2026-11-12-goal-detail-information.md)
replaces the Task panel and default selection while retaining the separate
Description reader and its shared navigation support. The
[Goal browsing decision](2026-11-11-goal-browsing.md) continues to own scope
projection and detail lifetime. The
[standalone reading-history decision](2026-11-11-standalone-resource-reading-history.md)
continues to distinguish shareable root selections from same-session nested
selections. The [Web design](../../../../docs/design/daynight-web.md) describes
the current presentation.

## Alternatives

**Deliver the panel separately from navigation support.** The panel would lack
direct links and history restoration, leaving Description inaccessible through
the established reading navigation contract.

## Consequences

The separate Description reader established an additional shared navigation
selection, while ordinary Task detail explicitly restricts its supported tabs.
Nested Goal selections remain session history rather than shareable URLs. The
original independently scrollable Task panel is superseded by project-list task
browsing and the detail information aside.
