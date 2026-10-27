# Agent Note: Stable Worker Git Workspaces

Status: implemented

## Problem

An acquired task needs a writable checkout that survives process interruption
without losing uncommitted work. A deterministic task path can later be occupied
by another claim or unrelated directory. Creation and deletion can succeed before
the local database records their result, and partial recursive removal can erase
ordinary Git files while leaving the old checkout in use or without attribution.
A path or task ID alone cannot authorize reuse or deletion.

## Decision

The [worker Git manager](../../../../packages/daynight/src/commands/worker/worktrees.ts)
provides repository preparation, task worktree creation/verification and terminal
removal. It consumes the project mapping and static task/claim/worktree owner and returns
actual bindings to its caller. The [six-column record decision](../simplification/2026-10-27-worker-claim-records.md) removes saved resource bindings from the local task row.
It does not add a second database, registry or recovery coordinator.

Repository preparation clones only missing paths. Existing non-bare repositories
must physically match their configured top level and a single origin matching the
shared generic repository-address identity. GitHub-specific API identity is not
required. Clone or setup failure remains visible and preserves partial resources
for inspection rather than treating an existing path as a fresh destination.

Each task uses `.worktrees/daynight/<taskId>` and `daynight/<taskId>`. The initial
branch starts at repository HEAD; a retained branch starts from its existing tip.
The same valid claim reuses its original checkout and dirty state without reset
or clean. A new claim gets a new worktreeId and new native execution; a conflicting
old path is retained and rejected. Missing original resources are recovery errors,
not permission to create a replacement checkout. Ordinary preparation and
verification also check the actual task worktree origin against its original
repoUrl, including worktree-specific configuration.

Creation exclusively reserves the empty leaf directory, captures its device/inode
and uses Git's native `worktree add --lock --reason` to persist a
`daynight-worker:` JSON owner marker in the linked administrative registration.
The marker contains origin/project/task/claim/worktree identity plus fingerprints
of the leaf, repository root and common directory. Those fingerprints corroborate
ownership; they do not prove an immutable directory incarnation. Every present
leaf must retain its exact regular `.git` pointer to the validated administrative
registration, including during terminal cleanup. Inspection also checks the
marker and administrative backpointer; a foreign marker, symlink, ambiguous
registration or missing/mismatched pointer blocks destructive operations.
Matching Git creation can be discovered directly from static registration; an
unmarked pre-add reservation remains a visible conflict.

Branch validation invokes Git's `symbolic-ref --quiet HEAD` with the validated
linked administrative directory explicitly selected by `--git-dir`. Git owns the
refs-backend interpretation, including reftable. This also verifies the original
branch when the leaf is already absent. A detached or different branch is refused.

Terminal removal requires caller confirmation that the original agent stopped
and its workspace closed. It still checks the original repository, full owner
marker and physical bindings, while a task-local origin change does not block
terminal cleanup. The manager recursively removes all leaf entries except the
exact `.git` pointer. Content-removal failure retains that pointer and the native
owner marker so a later attempt can revalidate and continue. Only after other
content is gone does it unlink `.git` and remove the leaf nonrecursively. Once
the leaf is absent, targeted locked-worktree removal discards its administrative
registration. Repeating a completed removal succeeds when both are absent.
Branch and task history remain; done/release/transfer share this terminal rule.

An interruption between final pointer unlink and leaf removal leaves a present
but ambiguous directory. Even an empty leaf with matching inode is refused and
local responsibility remains active with an error. An operator must inspect and
resolve that path; once it is absent, cleanup can finish the registration. No
new sidecar marker, schema field or ownership ledger is introduced to automate
this narrow ambiguous window.

The existing Git runner accepts per-call environment and deadline overrides;
ordinary repository discovery keeps its defaults. Worker setup clears inherited
repository selectors, command configuration and trace injection, disables hooks
and submodule recursion for its commands, and supplies an owned empty clone
template. Normal global authentication and transport settings remain inherited. Operations are
bounded and cancel through the runner's process supervision. Temporary hooks are
owned by the manager and removed by `dispose`; agent business Git operations
retain their repository workflow.

The [worker design](2026-10-22-worker-design.md) retains resource responsibility
boundaries; the [review worktree decision](../../archived/architecture/2026-10-17-owned-review-worktrees.md)
records the choice of disposable detached PR checkouts for review. Their different mutation rules
are separate despite reusing narrow Git, identity and physical-path primitives.

## Alternatives

**Reuse the review worktree manager.** Review prepares detached captured PR
revisions and can reset/clean disposable content. Worker agents make commits on a
stable branch and must retain dirty context while their claim remains valid.
Sharing those lifecycle operations would permit destructive review behavior in
worker recovery; the narrow command and path primitives are reused instead.

**Use persisted paths as complete ownership proof.** A task path can be replaced
or occupied before creation commits. Native locked registration joins the claim
to the original physical directory without adding another SQLite table or a
sidecar owner ledger. It also permits reconciliation after a lost create result.

**Remove through Git before checking leaf deletion.** Git can remove its linked
administration even when recursive leaf deletion fails. That loses the ownership
marker needed to attribute the remaining directory. Removing ordinary content
first retains native registration and the exact leaf pointer while that work is
retryable; the final pointer-unlink window remains explicitly ambiguous.

**Treat inode and timestamps as directory incarnation proof.** The initial
fingerprint joined native registration to the physical leaf. A local
delete/recreate probe reproduced equal device, inode, birthtimeNs and ctimeNs,
so adding timestamps still could not establish that a present pointerless path
was the original directory. Retaining the exact pointer until the last removal
step preserves a concrete registration link; missing-pointer ambiguity stays
visible rather than granting destructive authority.

**Read administrative HEAD as a loose symbolic-ref file.** That assumes Git's
refs storage layout and rejects valid reftable worktrees, whose administrative
HEAD contains a [sentinel rather than the branch](https://github.com/git/git/blob/16bd9f20a403117f2e0d9bcda6c6e621d3763e77/refs/reftable-backend.c#L464-L490).
Backend-aware Git symbolic-ref resolves the branch through the explicitly
validated administration, including after the leaf is gone.

## Consequences

The manager preserves primary files, unrelated branches and dirty task results
on ordinary recovery. A missing original or unmarked interrupted reservation
requires visible intervention; automatically adopting it would erase the proof
boundary. The final pointer-unlink window intentionally requires operator
inspection when a leaf remains; missing `.git` cannot be treated as ordinary
partial cleanup. Terminal ownership exits intentionally remove uncommitted leaf
files, so the agent must complete required delivery before its final done or an
explicit management action.

Git operations return resource facts, not ownership eligibility. The coordinator
still obtains complete current claim inventory, supplies stop/closure proof,
serializes each execution and retains call-local stop and cleanup observations. Failed deletion
must retain local responsibility. These primitives do not establish the foreground
scheduler, native Herdr execution, service management-protocol revisions or
cross-platform whole-Goal acceptance.
