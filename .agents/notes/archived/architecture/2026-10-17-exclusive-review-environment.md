# Agent Note: Exclusive Review Environment

Status: implemented

## Problem

Deleting review artifacts becomes ambiguous when arbitrary external checkouts
can depend on Git administration inside a PR worktree. Separate primary
checkouts need not leave a reverse pointer in that administration. Supporting
those relationships would require restrictions or ownership tracking beyond
the needs of a dedicated code-review environment.

## Decision

Configured repository clones and their PR worktrees belong exclusively to this
system. They do not host human development or other tools. Files, nested clones
and Git administration inside an owned PR leaf and its linked administrative
directory are disposable review content. Other consumers must not depend on
those resources.

This replaces the nested-dependency preservation policy in the
[owned-worktree decision](2026-10-17-owned-review-worktrees.md). The manager uses
standard Git operations to refresh and remove validated owned worktrees. It
does not inventory nested Git metadata, infer primary-checkout locations, or
reject disposable clones merely because they contain Git administration.

Fixed paths, persisted PR/session registration, linked administration identity
and process exclusion still establish which worktree can be changed. Captured
commit identity and complete checkout remain necessary for a correct review.
Same-target retries preserve local context. A new revision can discard previous
review artifacts; closure cleanup removes the owned leaf and its Git entry
while retaining the session and review history.

## Alternatives

**Preserve arbitrary external consumers of review artifacts.** Recursive metadata
inspection can find linked worktrees but cannot discover every separate primary
checkout. Failing whenever a non-bare repository has no explicit primary pointer
would also block ordinary generated clones. Both choices impose shared-workspace
requirements on an environment whose contents are dedicated to review.

**Reject all nested repositories.** Review tooling can generate temporary clones
and initialize submodules. Their presence does not change ownership of this
dedicated environment, so rejecting them adds interruptions without serving the
selected lifecycle.

## Consequences

Refresh and cleanup have one ownership boundary: the registered PR resources.
Tests verify disposable nested artifacts, correct target selection, complete
captured checkouts, retry continuity and isolation between PRs. Tests do not
promise preservation for external checkouts referencing review-owned metadata.

Shared developer checkouts would require a new environment contract and design.
The system retains explicit errors for wrong paths, registrations, active work
and uncertain process execution; dedicated ownership does not prove that an
agent has stopped.
