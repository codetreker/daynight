# Agent Note: Owned Review Worktrees

Status: implemented

## Problem

Git worktrees share repository administration and refs. A checkout discovered
through a parent can have the expected common directory while actually operating
on the user's primary worktree. Refreshing disposable review files must not reset
shared branches, remove another PR worktree, or erase uncertain execution.

## Decision

The Git manager maintains ordinary clones and a fixed `.worktrees/pr-<number>/`
directory beneath each repository root, implementing the
[repository-local layout](2026-10-16-repository-local-review-worktrees.md).
The caller owns the PR operation reservation and confirms process exclusion.

Missing repositories use a normal HTTPS clone with explicit origin selection.
Configured SSH addresses identify the same repository; HTTPS transport uses
prepared GitHub CLI credentials without requiring an SSH key. Authentication,
including API ports, reuses the [private credential mechanism](2026-10-17-github-observation.md).
Existing clones are verified through raw local origin configuration and stable
GitHub identity; their remotes remain unchanged.

Clone and initial Git inspection use the validated physical path, retaining the
configured alias for identity checks. Git's native filename protections remain
enabled. Valid leading/internal spaces are exercised on every platform; POSIX
trailing-space names are preserved, while protected Windows names must fail
visibly without removing an existing parent or other user data.
The inspected [Git for Windows path check](https://github.com/git-for-windows/git/blob/5cf10d74486d1e59b9ae6cedaedb4e26314e1557/compat/mingw.c#L4093-L4112)
rejects trailing-space/dot components before path conversion while NTFS
protection is enabled.

Fetch uses an explicit HTTPS URL, empty refmap, atomic private refs, no tags,
no FETCH_HEAD write, no automatic maintenance, and explicit submodule recursion
suppression. Shallow clones acquire required history. Immutable review head,
base, and merge-base refs retain captured context across later fetches.

Controlled Git commands disable replacement objects and use an owned empty
regular graft file. Local `refs/replace` and default `info/grafts` can otherwise
change a tree or parent graph while the captured object ID still matches. User
metadata stays untouched. The prepared result includes noncredential
`gitEnvironment` overrides so the Copilot adapter uses the same raw-object
view. The cached context keeps its empty hooks/template directory separate from
the empty graft file and remains valid for the runner's lifetime.

Owned review preparation also uses command-scoped complete-checkout settings.
Primary sparse patterns and sparse-index choices do not restrict the PR leaf.
For an unlaunched preparation, target and authority checks precede an owned
index rebuild (`read-tree --empty`, then full target materialization) and detached
checkout. This clears inherited skip-worktree bits, including unchanged excluded
files. Primary shared/per-worktree config, patterns, index and files remain
untouched. Launched same-target retries retain their local context.

The returned noncredential Git environment includes three controlled sparse
configuration entries. A runner removes inherited repository/config selectors
before applying these entries and the raw-object settings; user transport
authentication/trust is retained.

Every Git call disables hooks and fsmonitor through command-scoped settings.
Clones use an owned empty template. Repository-selector and trace environment
variables are removed only from children; transport trust settings such as
GIT_SSL_CAINFO/GIT_SSL_CAPATH and global configuration locations remain inherited.
Configuration and Git share the same
physical-directory and remote-identity helpers.

The configured root must physically match Git's exact top-level directory. An
owned PR leaf must be an ordinary directory at the fixed path, have the expected
top-level/common-directory identities, and have a registration locked with
`daynight:<sessionId>`. The persisted session UUID doubles as the ownership
marker. Container/leaf symlinks, unregistered directories, and mismatched locks
are rejected.

The leaf's regular `.git` file must resolve to its own linked administrative
directory, an immediate physical child of the expected common worktree registry.
Its session lock and `gitdir` backpointer must identify the same leaf and
registration. Relative metadata paths retain Git's documented base directories.
Forced checkout and clean commands explicitly bind this validated Git directory
and worktree, rather than rediscovering authority from a mutable `.git` pointer.

The database records intent before creation, after collision checks. An intent
with no leaf or entry can retry; a matching locked entry can be reconciled.
Unmarked resources remain untouched. Missing owned leaves use targeted locked
registration removal, never global pruning.

New revisions detach before discarding owned changes. Current and target
gitlinks are checked so newly introduced submodule paths cannot retain previous
artifacts. Owned submodule working directories can be emptied while shared
administration, refs, config, and primary submodule files remain unchanged.
Nested clones and generated administration inside the owned leaf and its linked
admin are disposable. Same-target confirmation/retry retains local files and
branch context.

The [exclusive-environment decision](2026-10-17-exclusive-review-environment.md)
defines configured clones and their PR worktrees as dedicated system resources.
Standard Git refresh/removal operates on validated owned paths without inspecting
nested repositories for external consumers.

Cleanup requires no active review, stopped operations, excluded processes, and
fresh closure evidence. Reopening withdraws deletion eligibility while retaining
the durable pending marker and error. Cleanup awaits commands already started;
only conclusive operation completion and agent exclusion permit cancellation of
the marker for an open PR. Cancellation retains its worktree path and session,
and subsequent preparation can rebuild a missing leaf. Uncertain cleanup keeps
the marker even when a newer observation is open. Git removal precedes database
completion. Normal failed cloning can remove only its unchanged, exclusively
created destination; cancellation or uncertain execution retains partial
resources for reconciliation.

The inspected Git contracts include
[private refmaps](https://github.com/git/git/blob/67ad42147a7acc2af6074753ebd03d904476118f/Documentation/fetch-options.adoc#L191-L200),
[submodule fetch recursion](https://github.com/git/git/blob/67ad42147a7acc2af6074753ebd03d904476118f/Documentation/fetch-options.adoc#L212-L248),
[clone origin selection](https://github.com/git/git/blob/67ad42147a7acc2af6074753ebd03d904476118f/Documentation/git-clone.adoc#L209-L213),
and [worktree locks](https://git-scm.com/docs/git-worktree).

## Alternatives

**Use common-directory equality alone.** A missing leaf `.git` makes Git discover
the primary repository with the same common directory. Exact physical top-level
checks prevent forced operations from reaching it.

**Trust a matching top-level path without binding Git administration.** A `.git`
file redirected to primary or sibling administration can still report the leaf
as top-level while selecting another HEAD and index. Administrative identity and
backpointers provide the missing binding before any forced operation.

**Trust the head ID while honoring local replacement history.** Replacement refs
can redirect the checked-out tree without changing the reported head ID. Grafts
can change merge-base ancestry even when replacement refs are disabled. Explicit
raw-object interpretation preserves the captured GitHub target without rewriting
the user's local history view. See [Git replacement objects](https://git-scm.com/docs/git-replace).

**Treat database path registration as complete ownership proof.** Interrupted
intent can collide with unrelated resources. A session-labelled Git lock joins
the database intent to the physical registration.

**Inspect nested Git dependencies before deletion.** The original policy allowed
generated clones while trying to preserve their external linked worktrees. A
separate primary checkout can also depend on administration inside the PR leaf
without registering a reverse pointer. The later
[exclusive-environment decision](2026-10-17-exclusive-review-environment.md)
replaces that policy: generated review content is disposable, and external
consumers are outside the environment contract.

**Deinitialize submodules during refresh.** That modifies shared config. Emptying
owned working directories preserves shared administration without recursive
initialization, network fetch, or branch management.

**Honor primary sparse checkout in the PR leaf.** That can hide changed files
while HEAD still matches the captured target. Forced checkout or ordinary
read-tree alone retains old skip-worktree bits; changing primary sparse settings
would alter user state. A guarded rebuild of only the owned index provides a
complete review without modifying the primary checkout.

**Use CLI clone or named-origin fetch.** CLI clone can reconstruct URLs and drop
ports; named-origin fetch can update user remote-tracking refs despite private
destinations. Explicit transport and empty refmaps preserve these boundaries.

## Consequences

Real Git/SQLite fixtures verify clone identity, detached targets, force pushes,
shallow history, dirty context, ownership collisions, disposable nested clones,
submodules, missing resources, reopening, and preserved primary files/refs.
Native CI repeats these checks on Linux, macOS, and Windows.

Private review refs retain captured objects. Sessions and review history remain
outside disposable worktrees. The manager does not launch agents or establish
process exclusion; the coordinator supplies that evidence. Ambiguous ownership
or execution blocks destructive reuse.
