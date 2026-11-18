# Agent Note: Worker Sudo Fixture Handshake

Status: implemented

## Problem

The sudo cancellation case checks that a real privileged removal keeps its
task gate until it exits. Its previous fixture wrote readiness before sudo,
then used two seconds of child sleep and 150 ms of parent sleep. This left
readiness dependent on scheduling and did not prove the privileged child had
started before cancellation. A
[macOS CI sample](https://github.com/codetreker/daynight/actions/runs/44243743660/job/134600298999)
reported 3.002 seconds for the case.

## Decision

The [Worktree fixture](../../../../packages/daynight/test/commands/worker/worktrees.test.ts)
starts a privileged shell through actual noninteractive sudo. The shell checks
its effective user, signals readiness, and waits for a bounded, case-owned
release path. The parent cancels, verifies the original operation is unsettled
and an overlapping removal is rejected, and releases the root child to run
the original command. The fixture joins the real child and also publishes
release on failure before attempting cleanup.

## Alternatives

**Use shorter sleeps.** Duration would remain a proxy for privilege and gate
ownership, and a slow runner could invert the intended ordering.

**Replace sudo with an unresolved promise.** That would omit actual privileged
operation ownership and termination.

## Consequences

Ordering follows observable process state. Fixed waits are removed while
the original signal, real sudo, cleanup, and post-cancellation assertions
remain in place. Production policy and limits are unchanged.
