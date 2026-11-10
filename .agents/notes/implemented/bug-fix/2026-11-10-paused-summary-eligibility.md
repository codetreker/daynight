# Agent Note: Exclude completed tasks from pause summaries

Status: implemented

## Problem

A completed task can retain `properties.paused=true`. Counting it in pause
summaries suggests that an operator has an outstanding paused task and can make
the project overview navigate to that completed task. The property still matters
on the task itself, including its detail and unpause operation.

## Decision

Web pause summaries count unique task IDs whose raw pause property is true and
whose current status is not `done`. A shared pure selector applies this rule to
the complete project or ordinary chain scope. Project overview navigation uses
the same eligible set and original task order. `cancelled` retains its existing
eligibility, and a status update recomputes the summary without a property
change.

The raw `pausedTaskIds` projection remains status-independent for task badges,
graph nodes and detail behavior. No server, graph or persistent-cache field is
added. The [Web requirements](../../../../docs/spec/daynight-web.md#暂停展示与解除)
and [design](../../../../docs/design/daynight-web.md#暂停展示与解除) own the
presentation and data flow.

This partially replaces the status-independent count in the archived [Web pause
controls decision](../../archived/feature/2026-11-04-task-pause-web-controls.md).
That decision separated the pause property from task status so discovery and
unpause remained possible regardless of execution state; the raw presentation
continues to preserve that distinction.

## Alternatives

**Clear the property or filter the raw set on completion.** Either approach
would remove the task's own paused presentation and change detail behavior,
conflating aggregate eligibility with the stored property.

**Apply a separate status filter in each consumer.** Four independent rules
could diverge between counts and overview navigation. A shared selector keeps
eligibility consistent while allowing each consumer to provide its full scope.

## Consequences

Completed tasks no longer contribute to pause totals or become overview pause
targets, but their raw pause remains visible and can still be cleared. Reopening
a paused task restores its summary eligibility. Counts remain independent of
pagination, filters, graph visibility and external prerequisites; other task
statistics and worker pause behavior are unchanged.
