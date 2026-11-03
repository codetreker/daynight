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
unchanged bytes. Each sequence uses its original manager under the existing
five-second behavior budget.

The existing per-test cleanup disposes operations and Git managers and removes
the case-owned directories. Other worktree tests do not run these preparation
hooks. The [release-packing fixture decision](2026-11-03-publish-fixture-behavior-budget.md)
uses the same budget separation for a real npm operation.

## Alternatives

**Raise the test timeout.** A larger shared budget would continue mixing
bootstrap and assertion costs and weaken the existing behavior bound.

**Split each state transition into an independent test.** Separate cases would
duplicate preparation and lose the same-manager transitions from unrecognized
markers back to a recognized moved registration, or from live registrations to
a missing leaf and then removal. Keeping each behavior sequence preserves its
regression condition.

## Consequences

Repository preparation and behavior checks have separate, existing runner
budgets. The tests execute real Git and retain every original assertion; slow
setup fails as setup rather than being mistaken for slow discovery. The separate
empty-state case adds one private repository bootstrap instead of sharing
mutable state across tests. Production worktree behavior, platform selection
and timeout values remain unchanged.
