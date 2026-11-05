# Agent Note: Worker Bot Inventory and Repository-Free Startup

Status: implemented

## Problem

A long-lived independent assistant has no project or task claim. Requiring a
repository before a Worker can start makes that lifetime depend on unrelated
configuration. Reusing task rows would also charge assistant responsibility to
task capacity and cleanup policy. A lost registration response must not create
another native writer, and a partial remote list must not erase local execution
or deletion responsibility.

## Decision

Worker run accepts an empty repository list without prompting. Explicit setup
and repo commands retain repository selection. This partially supersedes the
[repository selection decision](2026-10-27-worker-repository-selection.md):
startup reads service and Worker settings from one snapshot, takes the existing
instance lock and reconciles original tasks even with no configured repository.

The existing Worker SQLite format gains an independent Bot table. Owner-scoped
records retain the last complete definition alongside current observations and
a fixed launch intent. Preparation commits registration, execution, Controller,
launch and initial-operation identities before external side effects. The first
registration version remains distinct from subsequent observed versions.
Session IDs come from the server; a bound session without original local intent
cannot silently become a new execution. Frozen roles are immutable and may be
prepared before registration without adding a user turn.

Complete pagination precedes reconciliation. Duplicate and missing IDs require
single-item authority; failures and 404 observations never delete responsibility.
Deletion-only projections retain the prior definition and execution evidence.
The [inventory design](../../../../docs/design/worker-bot-inventory.md) owns the
interfaces and persistence rules.

## Alternatives

**Reuse task rows and coordinator capacity.** This would require invented
project/claim/worktree identities and would make Bot lifetime consume task slots
or inherit task cleanup prompts. Independent rows preserve the actual ownership.

**A separate unversioned Bot database.** This would duplicate schema admission
and migration behavior. A new table under the existing format retains atomic
migration, strict version validation and the shared instance lock.

**Remove missing entries from a successful page.** Pagination is not a snapshot,
and deletion projections intentionally omit execution details. Single-item
checks preserve responsibility under page races and response loss; even a 404
does not prove that the local writer has stopped.

## Consequences

Task inventory and cleanup budgets remain independent of Bot count. A database
reopen resumes the same startup intent, while conflicting configurations and
bindings fail visibly. One Bot write is atomic; a later write failure may leave
earlier observations committed, and the next reconciliation reads that state.

The [Controller execution layer](2026-11-05-worker-bot-runtime.md) supplies
registration, process startup and grant renewal. Recovery and deletion execution
remain responsibilities of lifecycle integration. Keeping the
fixed identity and role record separate from current observations lets that
integration retry without replacing native sessions. The
[assistant composition](2026-11-05-assistant-composition.md) connects that runtime
and capability advertisement; inventory records alone do not prove runtime
availability or process termination.
