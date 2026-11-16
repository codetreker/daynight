# Agent Note: Project Status Multi-Select Preference

Status: implemented

## Problem

Choosing one status excludes other relevant work, and reapplying a selection after
a reload or project visit interrupts browsing. Restoring it after pagination
would briefly show the wrong results; shared browsers also need account and
project isolation.

## Decision

The ordinary project lists share an ordered set of task statuses, stored locally
per authenticated user and project and restored before matching and pagination.
An empty set is a valid selection. The compact checkbox popover exposes the set
and overview navigation saves any status adjustment needed to reveal its target.
Storage failures leave the current session usable and report the failure.
Search keeps its independent single-status contract. The [original filter
decision](2026-11-05-task-list-status-filter.md) records the complete-chain and
combined matching rationale; the [assignee preference](2026-11-09-project-assignee-filter-preference.md)
records the related storage boundary.

## Alternatives

**Native multiple select.** Its persistent list presentation does not fit the
compact toolbar or the requested popover interaction.

**Keep a single in-memory status.** It cannot express a combination or retain
the selection across visits.

## Consequences

The browser-local preference does not synchronize between browsers. Invalid
records fall back to all statuses with feedback; a valid empty array remains
distinct from a missing record. Full graphs, progress and counts retain their
existing scope while list matching and pagination use the selected set.
