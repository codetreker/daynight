# Agent Note: Complete TaskSync Session observations

Status: implemented

## Problem

The sparse four-state TaskSync map serves chain and Goal annotations, but an
omitted key cannot distinguish a Task without a current execution from an
unregistered Session or an observation failure. Ordinary Task rows need these
facts and a separately verified reading entry, including for Herdr and retained
historical Worker records. Per-Task reads would duplicate requests and would not
bind the result to the project's Task snapshot.

## Decision

TaskSync returns a complete observation for every visible in-progress ordinary
Task alongside the existing four-state map. The complete observation carries
the exact Task version, a distinguishable state, observation and freshness times,
nullable attention, and independently confirmed entry availability. A completed
Worker and its historical Session are not a current execution. Sampling and
binding checks use web and Herdr sources; a changed or unconfirmed execution
cannot inherit an old sample. Individual unavailable observations remain in the
map and set the partial flag; whole-read, access and cancellation failures retain
their errors.

The database snapshot supplies Task facts and sources before live sampling; a
final authorization and binding recheck supplies a database response clock.
The same Engine clock that timestamps Session samples supplies a separate
response clock after sampling and recheck. This keeps database Task start times
and Engine freshness times in their own domains without replacing the original
sync watermark. The existing map is derived from the same samples under its own
rules; its chain and Goal aggregation and the current Web consumer remain intact.
The [requirements](../../../../docs/spec/daynight-task-sync.md#完整任务-session-观测)
and [design](../../../../docs/design/daynight-task-sync.md#服务端-session-状态投影)
own the detailed protocol, failure and time rules. This extends the earlier
[server projection](2026-11-08-task-sync-session-projection.md) and preserves
the existing [list admission](2026-11-08-task-sync-session-list.md). The
[project observation consumer](2026-11-15-project-session-observation-consumption.md)
uses the complete projection independently for individual Task rows.

## Alternatives

**Reuse the sparse four-state map.** Its missing keys deliberately carry no
reliable contribution and cannot distinguish no execution, no registration or
an unavailable observation; assigning those meanings would alter aggregation.

**Use the existing narrow web-only source or read each Task separately.** The
former omits Herdr and complete binding facts, while the latter adds requests and
authorization work proportional to Task count. Batch sources and live scalar
sampling preserve project-level reads without inventing identities.

**Use one response time for both Task age and Session freshness.** Database and
Engine clocks can differ, so subtracting across them misclassifies both startup
age and freshness. Two anchors preserve their respective time domains.

## Consequences

Every response carries complete current observation work and bytes proportional
to the number of in-progress Tasks, even when the Task delta is empty. The
response does not claim an atomic instant across PostgreSQL and live cells, nor
eliminate processing and transport delay between its anchors and client receipt.
It adds no per-row HTTP requests, Session content replication, arbitrary size
limits or implicit permission to open a Session. Existing Web aggregation uses
the older projection; consumers of the complete map must independently check
identity, binding, time and access before presentation or entry.
