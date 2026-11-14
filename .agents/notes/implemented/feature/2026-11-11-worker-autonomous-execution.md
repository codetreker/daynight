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

The full startup prompt explicitly states sufficient authorization to complete
the task and instructs the agent not to ask again about procedural authorization,
including PR merge authorization. Task scope, independent pauses and revocations,
and CI, review and merge gates continue to apply.

The Worker's built-in startup, macOS continuation or recovery, and periodic
ping inputs share an instruction to inspect task and repository constraints and
available evidence, adjust the execution approach, investigate failed approaches
and choose feasible alternatives. Significant deviations and their reasons are
recorded. The agent preserves confirmed goals, scope, acceptance, external
commitments and authorization.

Human intervention is requested for an evidenced severe design conflict when
confirmed requirements or architecture constraints cannot all be met,
there is no feasible compatible alternative, and resolution requires changing a
confirmed constraint. The agent records evidence, affected requirements,
alternatives and the specific decision needed before using the existing
versioned pause and verified resume workflow. Ordinary information gaps, tool
unavailability, failed approaches, recoverable errors and obsolete steps alone
are not pause triggers. Pending review, approval, CI and polling timeouts remain
ongoing work after the agent has handled available feedback. The
[review-action decision](../bug-fix/2026-11-12-worker-review-action-before-wait.md)
adds an intervention path for an evidenced missing authorization for a necessary
action after other authorized work is complete. It preserves existing grants and
requires a concrete decision instead of unbounded review polling. Independent
pauses, restrictions, revocations and identity or permission changes remain binding.

The [earlier pause decision](../../archived/feature/2026-11-02-task-paused-worker-pings.md)
introduced a verified pause for necessary human intervention, including specific
information, decisions, authorization or actions unavailable within scope. That
threshold made sense to prevent an agent from continuing without necessary
human input. The initial autonomous-handling prompt narrowed the agent-initiated pause trigger
to verified design conflicts. The review-action decision now supplies the narrow
authorization exception above, while retaining the pause property's runtime
semantics and the original claim and resume checks. Current behavior is specified
in the [Worker specification](../../../../docs/spec/daynight-worker.md) and its
[prompt assembly](../../../../docs/design/daynight-worker.md).

## Alternatives

**Retain the broad necessary-intervention threshold.** It preserves an explicit
path for any missing input, but can turn ordinary execution choices and
recoverable failures into pauses despite an available in-scope solution.

**Allow the agent to change confirmed constraints to continue.** This avoids some
conflict waits but can change the goal, acceptance or authorization without the
responsible person's decision. Execution flexibility remains bounded by those
constraints.

## Consequences

Equivalent instructions reach each automatic business-input path, so recovery or
a ping preserves the same design-conflict and necessary-authorization thresholds. Agents must investigate and document material deviations and conflicts; prompt wording cannot itself prove
that their judgment or evidence is correct. The explicit authorization statement
appears in newly assembled full startup inputs; existing fixed inputs and separate
continuation and ping prompts are not rewritten. The existing property, claim and
Worker lifecycle, scheduling, input delivery and custom prompt layers are not
changed by this decision.
