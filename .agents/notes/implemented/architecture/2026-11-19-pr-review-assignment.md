# Agent Note: Persistent PR review assignments

Status: implemented

## Problem

Accounts need a durable reviewer for each synchronized open PR, including PRs
that already existed when a Worker became eligible. Assignment must converge
after either PR or Worker changes, survive restarts and concurrent servers, and
remain isolated by account and repository. Existing clients must retain their
current PR and Worker protocols.

## Decision

The server periodically reconciles saved open PR observations against enabled,
online Workers whose target configuration covers the Project and whose account
currently has access. A bounded keyset scan advances through Workers, Projects
and PR pages. A short transaction locks and rechecks the mutable facts before
inserting an account, Project, repository and GitHub PR identity with a unique
key. Existing assignments are retained. The independent authenticated read
returns only the caller's assignment and current Worker status.

The [assignment design](../../../../docs/design/pr-review-assignment.md) owns
the data, lifecycle, transaction and HTTP details. The separate
[participation decision](../feature/2026-11-19-worker-review-participation.md)
owns the account's Worker preference and version. The
[repository switching decision](2026-11-19-project-repository-switch.md)
owns the change to the Project's repository and Worker selections.

## Alternatives

**Assign only after successful PR synchronization.** This does not discover a
previously unassigned PR when a Worker comes online or its eligibility changes
without another GitHub event. Periodic reconciliation observes both sides.

**Persist an event queue.** Complete replay would require durable events from
every relevant PR, authorization, configuration and Worker transition. Bounded
scans and the assignment key provide recovery for this one-time assignment
without that additional event and replay machinery.

**Embed reviewers in existing PR responses.** Existing clients can parse those
responses strictly, and reviewer identity belongs to the calling account. A
separate resource preserves existing representations and isolates observations.

## Consequences

Assignments survive restarts, repository switches and transient eligibility
changes, and concurrent reconciliation cannot replace the first committed
owner. Switching back to a retained repository exposes its existing assignment;
the same PR number in another repository is independent. Eligibility changes
may take a later scan to appear; scans and the partial Worker index add database
work. The service records responsibility only: execution, capacity, manual
reassignment and delivery of review feedback require separate mechanisms.
