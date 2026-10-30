# Agent Note: Worker Worktree Behavior Budgets

Status: implemented

## Problem

The ownership-marker discovery test prepares a repository and two managed
worktrees before checking several unrecognized markers and a moved recognized
registration. Counting all of those serial native Git operations inside one
default five-second test callback makes the outcome depend on repository
bootstrap cost as well as the behavior being asserted. Native Windows process
startup can consume much of that shared budget.

## Decision

The [marker discovery case](../../../../packages/daynight/test/commands/worker/worktrees.test.ts)
owns a nested fixture-preparation hook. The hook creates its repository,
managed worktrees and original ownership marker. The test callback retains
the marker permutations, read-only checks, ownership verification refusals,
marker restoration and moved-registration detection under the original
five-second behavior budget.

The existing per-test cleanup still disposes operations and Git managers and
removes the case-owned directories. Other worktree tests do not run this
preparation hook.

## Alternatives

**Raise the test timeout.** A larger shared budget would continue mixing
bootstrap and assertion costs and would weaken the existing behavior bound.

**Split every marker into an independent test.** Separate cases would duplicate
repository setup and lose the same-manager transition from unrecognized
markers back to a recognized marker with a moved registration. Keeping the
behavior sequence preserves that regression condition.

## Consequences

Repository preparation and behavior checks have separate, existing runner
budgets. The test still executes real Git and retains every original assertion;
slow setup can fail as setup instead of being mistaken for slow discovery.
No production worktree behavior, platform selection or timeout value changes.
