# Agent Note: Implementation-ready Delivery Handoff

Status: implemented

## Problem

A delivery assignment can name a desired outcome and an implementation direction
while leaving the diagnosis, solution selection, interfaces or change sequence
undecided. An independent developer then inherits task design as well as
implementation, even though handoff presents the assignment as ready to execute.
Checking a substantive approach only for Goal members leaves standalone delivery
tasks with a weaker preparation threshold.

The earlier [task/session content decision](../../archived/process/2026-10-28-task-session-content.md)
removed universal solution files and evidence locations to preserve genuine task
content without copying Session organization. The
[content-sufficient handoff decision](../../archived/process/2026-10-25-task-content-handoff.md)
later retained task-specific implementation approaches for Goal delivery briefs.
Those distinctions protect content ownership, but do not by themselves require
every delivery assignment to have completed implementation design.

## Decision

The [task content standard](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/task-content.md)
owns delivery readiness. Before handoff, the assignment defines the concrete
problem and outcome, selected solution and rationale, detailed design, ordered
implementation steps, and observable acceptance with verification methods and
expected results. The author resolves research and design questions needed to
define that work; the implementer executes the selected solution.

[Handoff](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/handoff.md)
applies this threshold to standalone and Goal delivery tasks before approving
content. Creation and repository dispatch workflows prepare the same material.
The [Goal brief](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/goal.md#delivery-task-brief)
retains its four-part structure; its implementation approach includes the selected
solution, detailed design and implementation sequence, together with the task's
contribution and boundaries within the confirmed Goal.

Required implementation steps describe engineering changes, their targets,
expected results and necessary ordering. They belong to the task. Session command
schedules, tools, collaboration and debugging history retain their existing owner.
Normal code reading, local coding choices, debugging and verification are still
implementation work, but cannot supply missing requirements or substantive design.
Inline material and precise readable references remain valid; no separate plan
file or Task Steps resource is required.

Content readiness is distinct from scheduling readiness. An unfinished producer
can remain a prerequisite when agreed design, exchange contracts and integration
steps already define the consumer. An open producer design decision cannot stand
in for that definition. Explicit requirements, research and design tasks continue
to produce their own stage results.

## Alternatives

**Keep only the existing high-level implementation approach.** A solution
direction can leave component responsibilities, contracts and concrete changes
undecided, particularly for standalone delivery. It does not establish that the
developer can execute without completing the design.

**Define the detailed standard only inside handoff.** Creation, Goal breakdown
and repository dispatch would still prepare material under weaker definitions.
The shared content owner gives preparation and review the same threshold without
maintaining competing checklists.

## Consequences

More investigation and design must finish before delivery handoff. Small changes
can still have concise definitions, but an unresolved diagnosis needed to select
the fix prevents passing content review. UI finding packages must include a
selected implementation design and steps alongside their observed evidence and
interactive prototype.

The rule preserves stage confirmation, dependency blocking, authenticated
responsibility, exact-version writes and read-only review of already-enabled
tasks. It adds no CLI command, API gate or scheduling certificate; changed sources
still require review, and permission alone cannot certify later material.
