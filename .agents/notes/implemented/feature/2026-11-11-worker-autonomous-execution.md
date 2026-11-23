# Agent Note: Autonomous handling of unexpected execution conditions

Status: implemented

## Problem

A background Worker can encounter facts that invalidate its initial steps without
invalidating its assigned goal. Treating every information, decision, authority
or action gap as a reason for human intervention interrupts delivery even when
the agent can inspect the situation and continue within the confirmed scope.
Repeated requests for already granted procedural authorization can also interrupt
delivery. At the same time, changing a confirmed requirement or authorization to
work around a conflict would exceed the assignment.

## Decision

The original startup prompt stated sufficient authorization to complete the task
and asked the agent not to repeat procedural authorization questions. Task scope,
independent pauses and revocations, and CI, review and merge gates remained binding.

Startup, continuation and ping inputs instructed the agent to investigate
unexpected conditions, choose feasible alternatives within the confirmed goal,
and record significant deviations. The original decision limited intervention to
an evidenced severe design conflict that required changing a confirmed constraint.
This reduced unnecessary pauses for recoverable gaps while preserving the original
claim and versioned pause workflow.

The [earlier pause decision](../../archived/feature/2026-11-02-task-paused-worker-pings.md)
provided a broader verified pause for necessary human intervention. The narrower
threshold addressed excessive interruption of work that an agent could resolve.
The [subsequent execution and waiting decision](2026-11-18-worker-action-and-waiting.md)
replaces that threshold to handle genuine blockers requiring external resources
or input, and specifies action on existing failures before waiting. Current behavior
is specified in the [Worker specification](../../../../docs/spec/daynight-worker.md)
and its [prompt assembly](../../../../docs/design/daynight-worker.md).

## Alternatives

**Retain the broad necessary-intervention threshold.** It preserves an explicit
path for any missing input, but can turn ordinary execution choices and
recoverable failures into pauses despite an available in-scope solution.

**Allow the agent to change confirmed constraints to continue.** This avoids some
conflict waits but can change the goal, acceptance or authorization without the
responsible person's decision. Execution flexibility remains bounded by those
constraints.

## Consequences

The original decision retained the property, claim and Worker lifecycle,
scheduling, input delivery and custom prompt layers. Prompt wording cannot itself
prove that an agent's judgment or evidence is correct. The replacement decision
continues these boundaries while revising the shared guidance.
