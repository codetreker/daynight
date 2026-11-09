# Agent Note: Budget the real Git cleanup diagnostic workflow

Status: implemented

## Problem

The cleanup diagnostic regression creates a real clone and owned worktree before
injecting a Git removal failure and a SQLite diagnostic-write failure. Its
five-second default test limit can expire during that complete native workflow,
preventing the error-chain and retained-worktree assertions from running.

[Windows CLI verification](https://github.com/codetreker/daynight/actions/runs/42579725798/job/129035445633)
reports this case at 5027 milliseconds with a 5000-millisecond timeout. Adjacent
successful cases in the same file take more than six and twelve seconds. The
log identifies outer timeout exhaustion but does not identify the native command
active at expiry.

## Decision

The cleanup diagnostic case in `worktrees-ownership.test.ts` uses the same
explicit 60-second outer limit as the other real Git lifecycle cases in that
file. The limit covers private fixture creation, clone and worktree preparation,
ownership inspection, injected failures and final assertions.

The case retains real Git and filesystem operations, the real SQLite abort
trigger, both errors in `AggregateError`, the original Git error object as its
cause, and the pending cleanup record and physical worktree. Native command
limits and production cleanup behavior remain unchanged.

## Alternatives

**Replace preparation with mocked Git responses.** That would remove native
cost but weaken the proof that cleanup preserves a physically prepared, owned
worktree when both removal and diagnostic recording fail.

**Raise the global default.** Other tests would receive a larger failure window
without evidence that their workflows need it. The existing per-case Git limit
already expresses the necessary scope.

## Consequences

The regression can reach its assertions on slower native runners while retaining
a finite failure limit. A stalled workflow may now take up to 60 seconds to fail
this case. The limit is a test execution allowance, not a cleanup performance
requirement or evidence that any particular production Git command hung.
