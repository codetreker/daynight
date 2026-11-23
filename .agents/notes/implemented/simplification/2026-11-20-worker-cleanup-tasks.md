# Agent Note: Show tasks in cleanup in Worker monitoring

Status: implemented

## Problem

Worker monitoring mixes normal execution waits, maintenance and cleanup in one
activity list. The task panel already identifies ongoing execution, while an
operator looking for unfinished cleanup must distinguish it from unrelated
activity. Missing labels and partial visibility make text-based classification
unreliable.

## Decision

The detail view labels the section “Tasks in cleanup” and renders only
permission-projected activities whose `kind` is `cleanup` and whose scope kind is
`claim`. Filtering preserves observation order and operation identity. Existing
rows retain phase, queued/running/waiting/paused states, known times, wait reasons
and task links; omitted association labels retain the task ID fallback.

A displayable observation always retains the section. The empty state describes
no cleanup tasks for complete observations and no visible cleanup tasks for
partial or restricted observations. Unexpired retained observations use the same
filter after a failed refresh, alongside the existing failure notice.

This partially supersedes the all-activity presentation of the
[Web monitoring decision](../architecture/2026-11-09-web-worker-monitoring.md).
The [capacity responsibility decision](2026-11-18-worker-capacity-responsibilities.md)
still owns removal of its independent section. The
[Web requirements](../../../../docs/spec/daynight-web.md) and
[design](../../../../docs/design/daynight-web.md) own the complete visible rules
and implementation structure.

## Alternatives

**Keep all activity kinds under the existing heading.** Normal execution waits
and maintenance would continue to compete with cleanup, duplicating information
from the task panel without isolating cleanup work.

**Classify from status text or association labels.** Execution and cleanup can
both wait, labels may be omitted by projection, and task business status does not
define the activity kind. Those inputs would hide valid cleanup or retain
unrelated activity.

## Consequences

The section directly exposes cleanup, including observation waits and retry
backoff. Execution, maintenance and non-claim cleanup activities remain in the
monitoring contract for other consumers. Worker scheduling, reporting, API
validation, permissions and storage keep their existing semantics. The view does
not infer hidden counts or treat an empty filtered list as an idle Worker.
