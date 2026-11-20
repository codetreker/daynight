# Agent Note: Remove Worker Monitoring Diagnostic Panels

Status: implemented

## Problem

Worker runtime monitoring combines scheduling and capacity information with
separate diagnostic panels for current failures, recent recovery and monitoring
report delivery. These panels increase the amount of information operators must
scan when examining active work and available capacity.

## Decision

The Web runtime monitoring view omits all three diagnostic panels, including
their details, empty states, links and recovery instructions. The task panel,
monitoring time, scheduling, capacity breakdown, admission and activities remain;
monitoring read errors, retry and freshness states remain distinct from report
delivery diagnostics. Other tabs do not acquire replacement panels.

The full observation, including `currentFailures`, `lastRecovery` and `delivery`,
continues through the existing Worker, Server and strict Web reader contract.
The [Web requirements](../../../../docs/spec/daynight-web.md#我的-worker) and
[monitoring contract](../../../../docs/spec/daynight-worker-monitoring.md) own
the resulting behavior and field guarantees. This narrows the presentation in the
[Web monitoring decision](../architecture/2026-11-09-web-worker-monitoring.md),
[system monitoring tab decision](../architecture/2026-11-18-worker-system-monitoring-tab.md),
[capacity responsibility decision](2026-11-18-worker-capacity-responsibilities.md)
[failure worktree decision](../architecture/2026-11-11-worker-failure-worktree.md),
and [card summary decision](2026-11-11-worker-card-monitoring-summary.md).

## Alternatives

**Keep the diagnostic panels.** This preserves their inline detail and recovery
instructions but leaves those diagnostics in the runtime monitoring view.

**Remove the diagnostic fields from the protocol.** Independently deployed
Workers, Servers and strict Web readers still require the existing fields; their
removal would reject complete observations during an uncoordinated upgrade.

## Consequences

Runtime monitoring no longer exposes those diagnostic details or their recovery
instructions. Existing monitoring data, local diagnostics, cleanup and recovery
commands retain their own contracts and safety checks. Capacity is still reported
as a total and optional active/retained breakdown without deriving it from the
removed detail.
