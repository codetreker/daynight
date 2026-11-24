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

The production Task reading surface mounts the
[ordinary relationship component](2026-11-23-web-ordinary-task-relations.md).
`TaskStatusConfirmation` distinguishes ordinary cancellation from the explicit
descendant intent offered after an unfinished-child refusal. The reviewed Task,
exact version and project history remain fixed through confirmation and mutation
preparation. Only explicit descendant confirmation sends `cancelDescendants:true`;
dismissal sends no request. Unknown outcomes retain GET-only reconciliation.
Validated `ApiError.taskIds` feed shared `TaskLifecycleBlockers` links to real
Task detail URLs, with localized reasons and no fabricated inaccessible titles.

At adoption, a trusted delete receipt or `410 task_deleted` retired the entire
old project presentation because persisted relations could not prove unaffected
rows. `retireTaskHistory` and `fenceTaskHistory` withdrew graphs, lists, details,
attachments and personal-inventory rows before a new epoch was observed. The
same-account late-204 rule also fenced replacement presentation independently
of the original target's outcome admission. This avoided hidden descendants
remaining visible when refresh failed, but interrupted unrelated reading and
could not associate a late receipt with the replacement history.

The [targeted read-admission decision](2026-11-24-task-removal-read-admission.md)
supersedes those deletion-driven project retirement rules. Current trusted
resource hints withdraw the exact target and require fresh reads for potentially
affected resources. The complete graph remains until an authoritative atomic
sync updates it. Real epoch, access, identity and scope retirement still
withdraw old project presentation. Old-history receipts do not affect a new
history, and local display never grants resource or write admission.

The original project retirement replaced cross-history display retention in the
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

Cancellation and unknown-result behavior share the existing mutation owner.
The original immediate project withdrawal protected incomplete cached ancestry
at the cost of graph interruption; targeted authoritative removals now preserve
unrelated same-history content while requiring potentially affected direct
readers to revalidate. Real history replacement still requires new authorized
reading and retires old graph navigation. Late results cannot resurrect a
retired subtree or qualify a prepared write.
