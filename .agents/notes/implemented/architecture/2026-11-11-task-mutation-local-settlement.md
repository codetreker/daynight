# Agent Note: Settle Task Mutations Before Presentation Admission

Status: implemented

## Problem

Task and Step writes share a result owner, but presentation admission can remain
paused after a request has been cancelled or its receipt observed. Waiting for
that admission to finish local settlement can retain a busy lock and promise
indefinitely. A late missing-resource response can also discard displayed
content, while an old success can reset a draft edited after local settlement.
Network cancellation alone cannot establish whether a dispatched write committed.

## Decision

The shared Task detail owner tracks the actual dispatch and trustworthy receipt
separately from its submitted replay guard. Each operation owns cancellable
preparation and admission waits. On pause, it settles the result locally against
its original operation or retired record without using gated resource access,
network reads, cache installation or deletion handling. An observed confirmation
remains confirmed; a dispatched operation without one remains unknown; local
cancellation and known refusal retain their existing classifications. A committed
version is recorded only when actually available.

Resource publication and subsequent reads retain their original admission and
identity checks. The original owner holds cancellable delayed publication, and
checks editor instance, in-memory draft revision and navigation context before
resetting or closing local state. Superseding or disposing the owner cancels the
work and receives its errors. A temporary pause can resume publication of the
same result without replaying the write. The [Task inspection design](../../../../docs/design/daynight-task-inspection.md#状态与详情会话)
and [Steps design](../../../../docs/design/daynight-task-steps.md#web-资源与单一写入所有者)
own the current contract.

This extends the [direct observation decision](2026-11-06-task-direct-observation.md),
which retains source-specific admission, and the [Step success continuation decision](../bug-fix/2026-11-04-step-success-terminal-continuation.md),
which prevents stale success from reviving a deleted detail. Both admission and
terminal checks remain necessary after local settlement.

## Alternatives

**Wait for admission in the original operation.** This preserves the existing
publication order but a permanent pause leaves busy and the caller's promise
unsettled, preventing local interaction.

**Treat network cancellation as a failed write.** A cancelled request may have
reached the server or already produced a confirmed receipt; collapsing these
facts can falsely report rollback or lose confirmation.

**Publish immediately when settlement completes.** Local settlement does not
establish current resource authority. Bypassing admission or checking only the
operation token can install stale data or reset a newer draft.

## Consequences

Task and Step callers regain local completion without replaying an uncertain
write or clearing retained content. Publication still needs the original
identity and resource fences, and later editing adds an in-memory revision and
navigation ownership check for destructive effects. The capability does not
itself enable an account-wide sticky pause or change other mutation owners.
