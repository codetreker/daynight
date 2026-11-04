# Agent Note: Generation-bound startup observations

Status: implemented

## Problem

A Controller can fail before its first relay hello while the service still has
only a registered, initializing Session. The Worker retains the initialization
error and may block recovery because no original native identity is proven, but
its ordinary phase and native ID summary cannot convey either fact. A timeout
also cannot establish that the provider rejected or never created a session.

## Decision

The Controller persists typed startup observations, distinguishing explicit
rejection from unknown transport outcomes. The Worker combines those facts with
its durable recovery block and publishes a generation-bound, monotonic report
through the existing claim update. Reporting remains independent of execution
recovery and does not send native input. The [protocol design](../../../../docs/design/task-session-protocol.md#启动观察的独立上报)
owns fields, ordering, permissions and compatibility.

A protected, separate task property stores the report. An explicitly negotiated
current response exposes only the matching claim, Session, generation and
Controller instance. Existing Worker and Session snapshot shapes remain stable.
The report contains fixed reason codes; safe text is derived from a fixed map,
while private raw diagnostics remain local. Observation timestamps describe
historical evidence, not current transport health.

The [persistent recovery pause decision](2026-11-04-web-recovery-pause.md)
continues to own recovery budgets, explicit retry, original identity and stop
proof. Its original implementation deliberately reported only phase and native
identity; the independent report adds visibility without changing those gates.

## Alternatives

**Put diagnostics directly in every Session snapshot.** This would reach live
consumers but would require compatibility projection across HTTP, welcome frames,
events and archives. Older strict consumers reject new fields, and a Controller
that cannot connect still needs an independent Worker path.

**Extend properties.worker directly.** Existing strict Worker parsers would reject
the entire task on every read surface. A separate protected property lets old
consumers retain their existing ownership parser.

**Report raw errors or infer failure from disconnection.** Raw provider errors can
contain paths, credentials or user input. Disconnection and native timeouts do
not prove rejection. Fixed classified reasons preserve useful facts without
inventing an outcome or publishing private logs.

## Consequences

The service can expose startup uncertainty and blocked recovery before any hello,
with the same task authorization and CAS used for Worker updates. Session fencing
and report revisions reject obsolete observations, including after grant rotation
that does not advance the task version. Reconciliation failures preserve local
facts and native recovery budgets.

The report is not a heartbeat or an authority to retry. UI presentation remains a
separate consumer of the contract. Old local records remain readable as unknown;
older binaries do not support downgrading a local JSON record containing the new
strict fields. Controlled stdio and HTTP/database evidence does not establish the
cause of a real provider initialization delay.

Service instances must be upgraded together before new Workers publish reports.
The old Go property registry cannot read the new stored property; wire compatibility
does not provide mixed-version server operation or storage downgrade support.
