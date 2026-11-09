# Agent Note: Worker Monitoring in the Web Workspace

Status: implemented

## Problem

Worker heartbeats and task snapshots do not explain scheduler progress, capacity
admission or cleanup failures. Operators need the current observation without
confusing missing or stale monitoring with idle work, and project access can change
while a page or request still holds associated details.

## Decision

The Worker pages read the independent monitoring contract alongside the existing
snapshot. The list batches loaded Worker IDs, and detail shows the actual scheduler,
capacity, activities, failures and latest recovery before host resources. Redis
observation time and a monotonic browser clock determine monitoring freshness;
the existing heartbeat clock still determines online status. Missing, expired and
failed reads remain distinct. The [Web design](../../../../docs/design/daynight-web.md#我的-worker-列表与详情)
owns request lifetimes and presentation, while the [monitoring contract](../../../../docs/spec/daynight-worker-monitoring.md)
owns fields and projection.

Monitoring reads share the authenticated workspace and Project generation fence.
Withdrawal removes affected associations and errors. Because public list reasons
have no scope identity, withdrawal invalidates the affected reason set while
retaining total capacity; an admitted reread can restore identity-free reasons.
Background checks preserve interaction state and independent configuration drafts.

## Alternatives

**Fetch monitoring detail for each list card.** This would multiply requests and
read complete observations for a summary. Bounded batch queries expose the
specified summary without a per-Worker fan-out.

**Treat a successful heartbeat as current monitoring.** Heartbeats and scheduler
observations can fail independently, so this would present stale or missing
runtime information as healthy.

## Consequences

Monitoring storage failures do not hide host telemetry or imply a Worker is idle.
The list is limited to the fields in the batch summary; richer diagnostics require
opening detail. Current permission checks and client withdrawal prevent a retained
page from restoring inaccessible associations, but the observation remains a
snapshot and does not establish claim ownership or control execution.
