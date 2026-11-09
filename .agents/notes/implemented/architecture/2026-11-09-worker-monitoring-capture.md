# Agent Note: Worker Monitoring Capture

Status: implemented

## Problem

Operators need to distinguish current execution, waiting and retained cleanup
capacity from an idle Worker. Heartbeats and logs do not establish scheduling
progress, and a monitoring outage must not delay business execution or cleanup.

## Decision

The Worker maintains a synchronous in-memory observation at actual operation
boundaries and shares its reservation projection with claim admission. An
independent bounded sender captures fresh state on its own cadence and reconciles
unknown results through the current-state API. The [monitoring contract](../../../../docs/spec/daynight-worker-monitoring.md)
owns the exchanged fields and the [reporting design](../../../../docs/design/daynight-worker-reporting.md#当前运行监控)
owns the producer lifecycle. The [storage decision](2026-11-09-worker-current-monitoring.md)
owns the server's CAS and retention choices.

## Alternatives

**Infer activity from heartbeats or logs.** This would confuse transport success
with work progress and turn diagnostics into a remote event stream; it cannot
reliably identify retained capacity.

**Send from each operation.** Slow or failed monitoring requests would couple
task operations to network behavior and accumulate obsolete states during an
outage.

## Consequences

Current observations are bounded and may be partial or stale, while admission
retains the complete capacity count. Fixed diagnostic summaries avoid uploading
arbitrary errors at the cost of remote detail. An independent sender preserves
business progress during monitoring failures but does not provide history or
replay after an outage.
