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
removal. It consumes the original project/task/claim/worktree identity and returns
actual bindings to the existing [local store](2026-10-26-worker-local-records.md).
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
of the leaf, repository root and common directory. Inspection checks that marker,
physical directory identities, fixed branch, `.git` pointer and administrative
backpointer. A replaced leaf, foreign marker, symlink or ambiguous registration
blocks reuse and deletion. Matching Git creation can be recovered before SQLite
binding is saved; an unmarked pre-add reservation remains a visible conflict.

Terminal removal requires caller confirmation that the original agent stopped
and its workspace closed. It still checks the original repository, full owner
marker and physical bindings, while a task-local origin change does not block
terminal cleanup. The manager removes the fingerprinted leaf before the
administrative registration. Partial failure therefore retains the owner marker
and permits continuation even if ordinary leaf metadata has already been removed.
Only after the leaf is absent does targeted locked-worktree removal discard that
registration. Repeating a completed removal succeeds when both are absent; a new
same-path directory or marker blocks old cleanup. Branch and task history remain.
The manager does not classify task status or distinguish done/release/transfer.

The existing Git runner accepts per-call environment and deadline overrides;
ordinary repository discovery keeps its defaults. Worker setup clears inherited
repository selectors, command configuration and trace injection, disables hooks and submodule
recursion for its commands, and supplies an owned empty clone template. Normal
global authentication and transport settings remain inherited. Operations are
bounded and cancel through the runner's process supervision. Temporary hooks are
owned by the manager and removed by `dispose`; agent business Git operations
retain their repository workflow.

The [worker design](2026-10-22-worker-design.md) retains resource responsibility
boundaries; the [review worktree decision](2026-10-17-owned-review-worktrees.md)
continues to own disposable detached PR checkouts. Their different mutation rules
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
marker needed to attribute the remaining directory. Leaf-first removal retains
that evidence until the destructive part has finished.

## Consequences

The manager preserves primary files, unrelated branches and dirty task results
on ordinary recovery. A missing original or unmarked interrupted reservation
requires visible intervention; automatically adopting it would erase the proof
boundary. Terminal ownership exits intentionally remove uncommitted leaf files,
so the agent must complete required delivery before its final done or an explicit
management action.

Git operations return resource facts, not ownership eligibility. The coordinator
still obtains complete current claim inventory, supplies stop/closure proof,
serializes each execution and saves successful bindings/cleanup. Failed deletion
must retain local responsibility. These primitives do not establish the foreground
scheduler, native Herdr execution, service management-protocol revisions or
cross-platform whole-Goal acceptance.
