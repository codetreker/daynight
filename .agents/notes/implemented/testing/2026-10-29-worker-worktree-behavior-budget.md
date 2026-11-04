# Agent Note: Worker Worktree Behavior Budgets

Status: implemented

## Problem

Resource-discovery tests prepare a private repository and managed worktrees
before checking Git registrations. Counting that serial native Git preparation
inside a default five-second callback makes discovery outcomes depend on
bootstrap cost as well as the behavior being asserted. Native Windows process
startup can consume much of the shared budget.

The ownership-marker case additionally checks several unrecognized markers and
a moved recognized registration. The claim-resource case checks live worktrees,
a missing leaf and removal while an unrelated locked worktree remains intact.
Those state transitions need the same manager and registrations throughout.

The combined claim-resource callback received a
[60-second native workflow budget](https://github.com/codetreker/daynight/commit/63e8d573efabe014bfc94d3a610bb22a579c28df)
while it still owned both preparation and discovery. That budget accommodated
serial native setup without changing individual Git or operation deadlines.
Separating preparation allows the discovery sequence to use the standard
behavior budget independently of bootstrap cost.

## Decision

The [discovery cases](../../../../packages/daynight/test/commands/worker/worktrees.test.ts)
own separate nested fixture-preparation hooks. Each hook creates only its
case's private repository, managed worktrees and supporting registrations.
The marker hook also captures the original ownership marker. The claim-resource
hook creates an unrelated locked worktree; an independent empty-repository case
retains the absence-of-resources assertion without preparing managed worktrees.

The marker callback retains its marker permutations, read-only checks,
ownership verification refusals, marker restoration and moved-registration
detection. The claim-resource callback retains its ordered live, missing-leaf
and removed-registration discovery checks, including the unrelated file's
unchanged bytes. Each sequence uses its original manager under the standard
five-second behavior budget. The combined scenario's explicit 60-second
override is removed; preparation retains the existing hook budget.

The existing per-test cleanup disposes operations and Git managers and removes
the case-owned directories. Other worktree tests do not run these preparation
hooks. The [release-packing fixture decision](2026-11-03-publish-fixture-behavior-budget.md)
uses the same budget separation for a real npm operation.

## Alternatives

**Keep preparation in a larger callback budget.** The 60-second budget covered
the combined native workflow while leaving individual Git and operation
limits intact. It continued to mix bootstrap and behavior costs. Case-owned
preparation gives those responsibilities their existing separate runner budgets
and restores the standard bound on discovery behavior.

**Split each state transition into an independent test.** Separate cases would
duplicate preparation and lose the same-manager transitions from unrecognized
markers back to a recognized moved registration, or from live registrations to
a missing leaf and then removal. Keeping each behavior sequence preserves its
regression condition.

## Consequences

The tests execute real Git and retain every original assertion; slow setup
fails as setup rather than being mistaken for slow discovery. The separate
empty-state case adds one private repository bootstrap instead of sharing
mutable state across tests. The claim-resource callback again uses the standard
five-second deadline after preparation moves to its existing hook deadline.
Production worktree behavior, platform selection, individual Git deadlines
and operation deadlines remain unchanged.
