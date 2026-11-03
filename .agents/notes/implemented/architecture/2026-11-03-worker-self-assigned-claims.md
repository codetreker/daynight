# Agent Note: Self-assigned worker acquisition

Status: implemented

## Problem

Automatic execution permission alone allows one project member's worker to
start work for another responsible person, or to consume tasks without an
assignee. Candidate selection and the final ownership transaction must agree
on which account may start that execution, while established execution
resources still need reliable recovery and cleanup.

## Decision

Automatic acquisition requires the task's non-null assignedTo to equal the
authenticated local user ID. Worker candidates use the existing assignedTo=me
selector together with readiness, permission and platform filters on every
page. The service rechecks assignment inside the existing locked project write
transaction before acquiring the claim. Direct claim callers have the same
restriction; project administration grants no automatic-acquisition exception.

This partially supersedes the [assignment foundation's original separation of
responsibility from eligibility](2026-11-03-task-assignment-foundation.md).
Assignment still does not transfer execution ownership. The [claim
foundation](2026-10-24-worker-claim-foundation.md) retains exact versions,
protected ownership and unknown-result reconciliation. Existing claims are not
revoked by the new acquisition condition.

Complete inventory continues to select only the authenticated user/worker's
active claims without assignment filtering. Recovery, completion and cleanup
follow that original execution identity. Explicit manual resume retains the
released-claim owner/admin authorization and its manual exception to automatic
eligibility. The [claim design](../../../../docs/design/daynight-worker-claims.md)
owns the operation details and refusals.

## Alternatives

**Filter only worker candidates.** This reduces irrelevant candidates but leaves
direct claim requests and changes after discovery unconstrained. Transactional
validation is required to make the responsibility rule authoritative.

**Filter every worker query by assignment.** An existing execution can belong to
an account different from the current assignee, including after explicit manual
resume. Hiding that claim from inventory would turn a valid execution into
apparent absence and could trigger resource cleanup. Acquisition and ownership
inventory therefore retain separate query conditions.

## Consequences

Unassigned and other-user tasks cannot be acquired automatically even when
permission and platform conditions pass. An assignee change continues to clear
automatic permission; a later explicit enable still applies only to the new
assignee's workers. Multiple machines for the same account retain exclusive
claim competition under the existing task version and project lock.

The change adds no tables, fields, historical identity inference or automatic
revocation. Older callers that omit candidate filtering still receive the
server refusal when attempting an ineligible claim. Existing execution and
manual-control authority remain independent from responsibility metadata.
