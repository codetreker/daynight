# Agent Note: Session Startup Presentation

Status: implemented

## Problem

A disconnected relay snapshot does not establish whether native initialization
ran, failed, timed out or was blocked from recovery. Independent header, empty
history and composer messages previously described the same failure differently.
Repeated live history requests could also fail without any new execution evidence.

## Decision

The shared Session View selects one primary state from the current execution's
startup report, connection evidence and request result. Terminal archive semantics
remain separate. Explicit failure stays distinct from uncertainty, and blocked
recovery retains its startup result. Starting observations expire after 90 seconds
for display only; no UI timer authorizes execution recovery.

The Task client negotiates the existing current endpoint during visible discovery
and receives subsequent Worker reports from authorized Task detail observations.
The existing channel supplies live snapshots and content. Identity and report
revision checks guard publication without reconnecting a healthy channel while
Task observation and execution ownership admission remain valid. The
[on-demand read decision](../simplification/2026-11-08-on-demand-task-session-reads.md)
replaces the original periodic full-current observation while retaining this
presentation and history policy. Only a connected, synchronized active snapshot
without failure or blocked recovery admits live history. Native initialization approvals remain usable.
A controller_offline response suppresses further reads against the same snapshot
until new evidence or explicit refresh. Loaded history and drafts remain owned by
the original execution. Permission loss clears protected content while retaining
safe errors.

Startup and connection diagnostics are localized and appear once in the header.
Fixed safe reasons expand with native keyboard-accessible details. Normal native
activity and operation labels keep the English behavior selected by the
[operation label decision](../../archived/bug-fix/2026-11-04-english-session-operation-labels.md); this
partially supersedes its blanket header-language rule for lifecycle diagnostics.
The [requirements](../../../../docs/spec/task-sessions.md#启动结果与恢复阻断) and
[design](../../../../docs/design/task-session-protocol.md#session-view-的启动状态选择)
own the current contract and mechanics.

## Alternatives

**Infer startup from epoch, waiting or missing native identity.** Connection epochs
span generations and a missing identity can follow an uncertain launch. These
shortcuts turn missing evidence into incorrect failure or queue claims.

**Reconnect to refresh Worker observations.** Reports are independent of the live
channel. Reconnecting healthy sessions disrupts pagination and causes unnecessary
history reads. At adoption, independent bounded current requests preserved channel
continuity; the on-demand read decision replaces their periodic use with existing
Task observations.

**Require ready before reading history.** Initialization can wait on a native
approval displayed in that history. The connected/synchronized gate permits this
interaction without granting input outside the existing native operation gates.

## Consequences

Users can distinguish blocked recovery from active synchronization without
exposing private logs. Stable drafts, timeline identity and archive reads retain
their existing owners. Task startup/recovery updates follow authorized Task
observations and do not cause periodic complete current reads. Independent Test
and Bot sessions keep their own authority checks and do not consume Worker
reports. Controlled browser fixtures demonstrate rendering and HTTP/WebSocket
behavior, not the cause or repair of a real provider initialization timeout.
