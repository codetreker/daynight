# Agent Note: Refresh the Task at the Web summary publication boundary

Status: implemented

## Problem

A Coordinator can read a Task in its inventory, then wait for resource scans,
Web advancement and startup-report capability checks before publishing a Web
execution summary. A preceding job for the same claim can commit and finish
after that inventory read but before the next job is admitted. Even with
serialized jobs, the next summary can therefore use an obsolete Task version,
be rejected, and defer an otherwise confirmable observation until a later round.
An unknown write outcome and a confirmed version rejection also require different
diagnostics.

## Decision

After local observation and capability checks, a candidate Web summary reads
the Task again at its publication boundary. It validates the original active
Web claim and compatible native identity, recomputes the summary against the
fresh fields, and submits only an actual difference with that Task's exact
version. An unchanged inventory summary skips the extra read. The
[Worker design](../../../../docs/design/daynight-worker.md) owns the complete
identity checks and reconciliation behavior. Server CAS and startup-report
generation and revision validation remain authoritative after the read.

Read failures, confirmed rejections and unknown outcomes return to ordinary
polling, without replaying native operations or input or changing recovery
budgets and pauses. A confirmed `409 version_conflict` is identified separately
from other failures while preserving the original diagnostic evidence. The
[startup observation decision](2026-11-05-session-startup-observations.md)
continues to own the report's identity and ordering.

## Alternatives

**Rely on the next inventory round after a stale write.** Existing CAS prevents
the old version from committing, and later reconciliation can repair the
summary. It still sends a redundant request and delays a valid observation when
the preceding job already committed after inventory, even though no native
recovery action is needed.

## Consequences

Candidate changes incur one additional Task read, while stable summaries incur
neither an additional read nor a write. The read narrows the stale-snapshot
window but cannot remove a concurrent update after the read; CAS still rejects
that race and a later round observes it. Paused native recovery and orchestration
blocks continue to permit a waiting summary for the original claim. Controlled
Coordinator and remote tests exercise the inventory-to-publication race and
failure outcomes; they do not establish the cause of an individual production
conflict whose preceding request chain is unavailable.
