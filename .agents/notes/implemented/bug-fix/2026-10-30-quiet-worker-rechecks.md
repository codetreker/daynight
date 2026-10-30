# Agent Note: Quiet Worker Rechecks

Status: implemented

## Problem

Returning to a Worker page or confirming the same account retains a previous
observation while the next read is pending. A large yellow synchronization
warning during that normal transition attracts attention and shifts the resource
cards even when the Worker recently reported successfully. Stale observation
state alone does not establish a failed read or an offline Worker.
The longer last-confirmed badge can also wrap adjacent report information onto
another line on narrow screens. Changing the task heading and inserting its
snapshot caption can move task rows even without a warning.

## Decision

Worker list and detail pages show the retained-snapshot warning only when a read
has failed. A pending recheck with no error leaves the existing content in place.
Last-confirmed badges, task snapshot captions and source timestamps continue to
identify retained observations. Existing errors and retry controls remain visible
through subsequent attempts until a successful observation replaces them.
Each status badge reserves the intrinsic size of its localized last-confirmed
label. The visible text and an invisible generated label share one grid cell,
so changing confirmation state does not resize the badge or rewrap its neighbors.
The reserve adds no duplicate DOM or accessible text and uses no fixed width.
The task panel reserves its current title width and keeps the snapshot caption's
layout footprint. A current observation hides that caption with visibility and
excludes it from the heading's accessible name; a retained observation reveals
the same element without moving the table.

The [observation lifecycle](../architecture/2026-10-29-web-worker-observations.md)
continues to own polling, authentication admission, time freezing and successful
recalibration. Offline and probe-error displays remain independent of browser
read failures. The [Web requirements](../../../../docs/spec/daynight-web.md#我的-worker)
and [design](../../../../docs/design/daynight-web.md#我的-worker-列表与详情)
own the resulting behavior and presentation.

## Alternatives

**Show a warning for every stale observation.** The original presentation made
retained state explicit while identity or visibility recovery awaited a fresh
read. Its repeated insertion and removal treated routine checks like failures
and moved the primary content. Existing inline labels preserve the observation's
meaning without a separate warning during successful recovery.

**Clear stale state when a recheck starts.** This would resume current-looking
status before a confirmed response and make frozen historical data appear fresh.
Keeping the observation lifecycle intact preserves its time and identity rules.

## Consequences

Routine rechecks preserve reading position and focus while fresh status, report
times and resource values still replace the retained data on success. A pending
request can continue to show a last-confirmed observation; it does not claim that
the browser has received a newer report. Actual read failures keep actionable
feedback, and offline Workers retain their separate snapshot notice.
