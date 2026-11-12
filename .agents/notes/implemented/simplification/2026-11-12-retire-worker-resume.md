# Agent Note: Retire Dedicated Worker Resume

Status: implemented

## Problem

A released task can be acquired through ordinary scheduling, but a separate
manual resume path can create a new execution while bypassing the assignee,
automatic permission, platform and Goal eligibility rules. Two acquisition
paths make those rules inconsistent and complicate source ownership handling.

## Decision

Remove the dedicated Worker resume command and API. New executions use ordinary
claim eligibility and fresh execution identities. Release checks the original owner, claim, version and stopped
source. It submits one request; only a validated response confirms release and
permits completion of the original source. Unknown outcomes are not replayed or
inferred from a later Task read. A confirmed release with failed local cleanup
retains that responsibility for reconciliation.

This supersedes the manual resume exception in the archived
[manual control](../../archived/architecture/2026-10-27-worker-manual-control.md)
and [self-assigned claim](../../archived/architecture/2026-11-03-worker-self-assigned-claims.md)
decisions. The [ordinary candidate decision](../bug-fix/2026-11-12-worker-released-candidates.md)
preserves the scheduling and local resource barriers that make this removal
possible. Same-claim recovery, native session resume and retry remain separate.

## Alternatives

**Keep explicit manual resume.** It permits an operator to override automatic
eligibility, but retains a second execution admission path and its exceptions.

**Infer release success from the latest Task.** A new claim or absent old claim
can establish that ownership ended, but cannot prove which request caused it.
Retaining the unknown result avoids reporting an unconfirmed operation as success.

## Consequences

Released tasks remain readable and enter ordinary candidate order; they wait
when ordinary eligibility is not met. The [release ownership decision](2026-11-12-release-clears-ownership.md) removes the released wire state;
resource/archive fences remain. A lost response requires reconciliation of the
original resources without treating the request as confirmed.
