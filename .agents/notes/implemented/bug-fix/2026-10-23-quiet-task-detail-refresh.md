# Agent Note: Quiet Task Detail Refresh

Status: implemented

## Problem

An unchanged task can move inside its open detail dialog on every automatic
refresh. Retaining the same components preserves inputs and preview state, but
inserting a progress paragraph above the tabs increases the heading height and
reduces the reading area's available height. Removing the paragraph after the
response reverses the movement. Existing retained-state checks do not establish
layout stability while a request is pending.

## Decision

Routine same-task detail reads retain the mounted content without adding a
progress paragraph to the heading. Required freshness and read errors expose the retained-detail explanation,
while stale-snapshot warnings and status reconciliation keep their own feedback
through the layout-independent layer owned by the
[notification decision](2026-10-24-task-detail-notifications.md). The dialog distinguishes
network activity from those actionable states. It still suppresses a stale
comparison while a read is pending, since the response can reconcile it.

The [automatic-refresh decision](../feature/2026-10-22-project-task-auto-refresh.md)
continues to own scheduling, request coalescing and full-detail reads after
every successful graph receipt. Equal graph data does not prove equal
description or PR properties. The
[status assignment decision](../architecture/2026-10-24-task-status-assignment.md) continues to
own precise-version status setting and required freshness; ordinary optional reads do
not change status-write eligibility. This decision narrows the presentation of
retained reads without changing either lifecycle.

The production `refresh-staleness` journey measures heading, tabs and the active
reading panel before, during and after held detail responses triggered by the
existing scheduler. Repeated unchanged responses isolate request presentation
from natural layout changes caused by new data. Component checks retain the
error, required-fresh-read and status cases; browser checks establish geometry
and retained interaction state at supported viewport sizes. Its only browser
mutation is one registered fixture-file PUT: the real server commits the upload
and its response stays pending across automatic reads. The scenario requires
exactly one write and no aborted request. Other browser mutations remain
failures; the existing scenario inventory and coverage gates remain in force.

## Alternatives

**Reserve permanent space for a refresh paragraph.** This stabilizes the
heading, but spends reading space on an intermittent transport status in every
dialog, including short and narrow viewports. The ordinary read needs no action;
its progress does not need a visible paragraph.

**Skip detail reads when the graph is unchanged.** This avoids some requests,
but graph responses omit descriptions and PR properties, and a later successful
read also recovers detail failures. It would change freshness behavior to solve
a presentation defect.

**Hide all retained-data and stale-state feedback.** This removes movement but
also conceals genuine errors and the reason status setting requires another read.
The original decision retained these states in the reading layout because they
require action. The notification decision preserves that visibility through
timed overlays and a persistent recovery entry without allocating reading height.

## Consequences

Unchanged background reads keep the current heading, tab bar and reading area
in place. Their existing DOM, focus, scroll, PR pagination, attachment drafts,
pending writes and preview lifecycle remain independent of graph polling.
Actual task content can still change the visible layout. Errors and freshness
feedback use the notification layer, extending layout stability beyond the
ordinary transport transition.

The transient refreshing-detail catalog entry is removed from both languages
and the typed catalog. No service, database, polling transport or new request
mode is introduced. Browser evidence remains source-bound in task or CI
artifacts; the requirements and design own the durable presentation contract.
