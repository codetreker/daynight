# Agent Note: Web Subtask Lifecycle and Project Retirement

Status: implemented

## Problem

An ordinary parent can be blocked by unfinished children, and explicitly cancelling
its descendants changes more resources than cancelling the parent alone. Readers
need the actual blocking Task IDs and a reviewed cancellation intent. Deleting a
parent also hides descendants whose edges may be absent from a shared cache written
by an older client. Keeping that project's old graph, rows or details until a new
snapshot arrives can expose descendants already hidden by the service, especially
when refresh fails or an earlier request completes late.

## Decision

Production Task Overview mounts the
[ordinary relationship component](2026-11-23-web-ordinary-task-relations.md).
`TaskStatusConfirmation` distinguishes ordinary cancellation from the explicit
descendant intent offered after an unfinished-child refusal. The reviewed Task,
exact version and project history remain fixed through confirmation and mutation
preparation. Only explicit descendant confirmation sends `cancelDescendants:true`;
dismissal sends no request. Unknown outcomes retain GET-only reconciliation.
Validated `ApiError.taskIds` feed shared `TaskLifecycleBlockers` links to real
Task detail URLs, with localized reasons and no fabricated inaccessible titles.

A current trusted delete receipt or `410 task_deleted` retires the entire old
project presentation because the persisted relation graph cannot prove unaffected
rows. `retireTaskHistory` and `fenceTaskHistory` withdraw graph/list
`displaySnapshot`, search, detail and attachment readers, and My Tasks rows before
a new epoch is observed. `historyChanged` stays distinct from access revocation
and reaches independent projection listeners and peer tabs. Captured per-project
read revisions reject delayed personal-inventory pages, preserving other projects.
New evidence must pass current admission before the affected project returns.

A trusted same-account `204` also fences project presentation when it arrives
after the reviewed Task history has been replaced. Marking that Task deleted
still requires the original operation and read ticket to be current. The receipt
proves a committed deletion, but cannot identify the replacement history's safe
rows; the existing epoch fence therefore withdraws its unproven presentation and
requires new reads. Authentication pauses retain the receipt for admission after
the gate resumes; identity retirement rejects publication. Deleted detail state
survives its own retirement notification until a new authorized opening or summary
establishes that the Task is present.

This replaces the cross-history display retention in the
[stable Goal reconciliation decision](../bug-fix/2026-11-16-goal-graph-stable-reconciliation.md).
Ordinary refresh failure within a still-admitted history continues to preserve
valid content and interaction state. Project retirement does not remove the user's
project membership or grant a new read from a cached object.

## Alternatives

**Retire only the deleted Task and cached descendants.** An older shared snapshot
can omit ordinary parent edges, so cached traversal cannot identify every affected
descendant or prove the remaining rows safe.

**Keep the previous display until a fresh snapshot succeeds.** This preserved Goal
viewport continuity before ordinary subtrees were exposed, but a failed refresh
would leave hidden descendants in old rows, graphs and private readers.

**Treat history retirement as project access revocation.** Deletion changes resource
visibility and epoch without removing membership. Conflating the events would
incorrectly deny later authorized reads of unaffected resources in that project.

## Consequences

The affected project's old content disappears immediately even when the next read
fails; other projects retain their rows and navigation. Recovery incurs fresh
authorized reads and can rebuild the affected graph rather than preserving its
old viewport across retirement. Confirmation and unknown-result behavior share
the existing mutation owner, and late reads cannot resurrect a retired subtree.
