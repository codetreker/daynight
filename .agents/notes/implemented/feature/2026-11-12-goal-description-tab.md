# Agent Note: Goal Description Tab

Status: implemented

## Problem

Goal description and child Task browsing share a panel, so a long description
competes with the organization and task list for the same reading space. Readers
need a clear way to reach each without losing their place or the existing Task
navigation and attachment behavior.

## Decision

Goal details provide Description before Tasks, Attachments and Discussion, with
Tasks still selected by default and represented by `overview`. Description owns
the existing Markdown reader and Goal attachment navigation. Description and
Tasks scroll independently, and all four panels retain their mounted state.
Shared URL and page history navigation accept `description`; ordinary Task
details normalize that Goal-only selection to Overview.

The [Goal browsing decision](2026-11-11-goal-browsing.md) continues to own
scope projection, cross-scope witnesses and detail lifetime. The
[standalone reading-history decision](2026-11-11-standalone-resource-reading-history.md)
continues to distinguish shareable root selections from same-session nested
selections. The [Web design](../../../../docs/design/daynight-web.md) describes
the current presentation.

## Alternatives

**Deliver the panel separately from navigation support.** The panel would lack
direct links and history restoration, leaving Description inaccessible through
the established reading navigation contract.

## Consequences

Readers can switch between independently scrollable description and task content
without resetting the other panel. The shared navigation admits an additional
selection, while ordinary Task detail must explicitly restrict its own supported
tabs. Nested Goal selections remain session history rather than shareable URLs.
