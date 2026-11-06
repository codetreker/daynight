# Agent Note: Explicit Incoming Reference Removal on Task Deletion

Status: implemented

## Problem

Deleting a task that other tasks reference requires editing every referencing task
before the target can leave normal views. The existing deletion preserves stored
work and refuses live references, but cannot express a single authorized removal
of those references and the target. Combining separate writes would expose partial
relationships, permit new references between writes, and make failures difficult
to reconcile.

## Decision

`daynight task delete` keeps strict deletion as its default. With no undeleted
incoming references, deletion succeeds without an extra flag; any such reference returns
`409 dependency_unsatisfied` with zero changes. Optional `--remove-depends`
explicitly selects atomic incoming reference removal and soft deletion. HTTP
`removeDepends` is optional and strictly boolean: absent/false remains strict,
while true selects removal. Web confirmation explicitly captures true and explains
removal of all references present at execution, including ordinary and external
relationships and possible readiness changes. Its authority names that category,
not the displayed count or a fixed reviewed list. Transport cannot infer the flag.

The project lock, member check, target version and active target-worker guard run
before mutation. Preparation only validates and returns a plan: service Faults
are returned after a successful outer transaction, so writing during preparation
could commit a refused operation. Actual removal belongs to delete execution.
It selects every source referencing the target, including already deleted sources,
removes those incoming edges and increments each affected source version and
updatedAt once. All other source fields, relationships, status, timing, worker
claim and deleted marker remain. An active source claim is allowed and remains
the same claim; its next write observes the changed task version.

The target's own outgoing references to prerequisites remain. The target marker,
version/updatedAt update, all incoming removals and source version updates commit
with exactly one project epoch rotation. SQL or transaction failures roll them all
back. When a new reference commits first, forced removal can then commit and
remove it; deletion first causes the new reference to fail normal target lookup.
Strict deletion continues to refuse a previously committed undeleted reference.

This partially replaces the [original soft-deletion decision](2026-10-25-task-soft-deletion.md):
reference refusal is now the default mode, and retaining incoming references is
conditional on that mode. Its original reasons for avoiding silent changes to
readiness remain applicable. Target/attachment retention, Gone responses, epoch
replacement, history-bound confirmations, auth-pause admission, operation ownership
and immediate ticket-bound negative revocation remain unchanged.
[Requirements](../../../../docs/spec/daynight-task-deletion.md) and
[design](../../../../docs/design/daynight-task-deletion.md) own the full contract.

## Alternatives

**Keep refusal and edit sources separately.** This preserves default safety but
requires a separate versioned mutation for every source and leaves a window for
new references before target deletion. The explicit combined operation provides
one project-locked result while strict deletion remains available.

**Remove incoming references for every deletion.** This would change readiness
without a CLI flag or explicit API true value. Optional selection preserves the
caller-visible refusal mode; Web names and confirms the combined action.

**Remove references during validation.** The service deliberately returns domain
refusals only after a successful outer transaction. Mutating a validation callback
could therefore commit reference changes when target checks refuse deletion.
Execution performs the complete accepted plan instead.

## Consequences

Removing a prerequisite can make an unfinished source ready and can change chain
classification, while source state and execution ownership remain intact. Each
source's version changes once, exposing stale concurrent observations. Whole-project
epoch replacement publishes the target's disappearance and changed sources in one
complete cache snapshot. The target and attachments remain retained, but explicit
removal also discards incoming references from deleted-source history.

Batch task deletion, cascading deletion of source tasks, transitive rewiring and
a public restore interface remain separate features. The operation removes only
direct references to one target and preserves the target's prerequisites, keeping
those additions independent of the existing marker, version and ownership rules.
