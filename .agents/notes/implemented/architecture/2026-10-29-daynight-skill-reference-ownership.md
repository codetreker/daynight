# Agent Note: Give each Daynight skill rule one reference owner

Status: implemented

## Problem

A broad skill entrypoint and command handbook mix navigation with workflow rules.
Readers load rules unrelated to their operation, while repeated authorization,
content and completion rules can diverge. General content and session boundaries
also need explicit owners for managed delivery requirements and intervention,
without turning task materials into execution logs.

## Decision

The canonical English skill bundle contains one navigation entrypoint,
[SKILL.md](../../../../packages/daynight/src/commands/skill/skills/using-daynight/SKILL.md),
and fourteen single-owner references. The entrypoint introduces concepts, routes
readers by purpose and identifies the explicit managed startup declaration;
operational rules live in the references. Readers load only the owners needed
for the current operation and their required references.

Shared execution owns PR description requirements for both execution modes:
explain the problem and solution, and include the ID and title of an associated
Daynight task.

| Reference | Rule ownership |
| --- | --- |
| [Authorization and scope](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/authorization.md) | Tracking, operational authorization and task boundaries |
| [Setup](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/setup.md) | CLI availability, sign-in, project and repository setup |
| [CLI handbook](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/handbook.md) | Command discovery and help entry points |
| [Project management](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/project-management.md) | Project identity, discovery and reuse |
| [Task management](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/task-management.md) | Task fields, lifecycle and dependency semantics |
| [Write safety](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/write-safety.md) | Versions, conflicts, uncertain writes and attachment concurrency |
| [Task content](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/task-content.md) | Definitions, artifacts, session separation and source ownership |
| [Create task](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/create-task.md) | Preparation, registration, prototypes and readback |
| [Goal protocol](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/goal.md) | Stage confirmation, breakdown and whole-Goal completion |
| [Handoff](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/handoff.md) | Content review and automatic-execution permission |
| [Ordinary execution](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/run-task.md) | Ordinary start, recovery, completion and return |
| [Shared execution](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/task-execution.md) | Inputs, delivery, waiting context and completion readiness |
| [Managed execution](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/autopilot-managed-task.md) | Sustained delivery, intervention and original-claim completion |
| [Final acceptance](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/final-acceptance.md) | Requirement-based conclusions, evidence and temporary-helper boundaries |

Installed `daynight --help` and the relevant subcommand's `--help` own CLI syntax
and option combinations. The handbook maps commands rather than duplicating
their argument contracts. Dependency creation, replacement and clearing require
`task graph` readback of affected components and required paths, checking
classification and reduction under the
[task-management rules](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/task-management.md#verify-dependency-changes).
The create-task owner requires a final-style interactive frontend-only prototype
with memory-only mock data; Goal stages reference that owner.

Managed execution owns the complete delivery standard: research reports,
design or architecture solutions after multiple independent reviews with no
Critical/Major issues, separate files for remaining nonblocking review issues,
and acceptance evidence are task attachments; development requires actual PR
merges and task acceptance. General inline sufficiency does not waive these
artifact requirements. Necessary user intervention uses `worker.signaling`:
record the reason on the task and print it, retain session waiting context and
`in_progress`, then exit the execution loop. After feedback, verify the original
assignment and resolution, remove the signal and confirm removal before resuming
the same task. The structured signal is not permission to copy full execution
logs or checkpoints into task material or to select other work.

This decision partially supersedes the reference placement and affected current
rules in the [managed execution decision](2026-10-26-managed-task-skill.md),
[task-content and handoff decision](../process/2026-10-25-task-content-handoff.md),
[task/session content decision](../process/2026-10-28-task-session-content.md),
[tracking and design-review decision](../process/2026-10-24-daynight-tracking-and-design-review.md)
and [Goal workflow decision](../process/2026-10-22-goal-workflow-design.md).
Their historical rationale, genuine alternatives and unaffected decisions remain
active; managed artifact and signal requirements qualify the general boundaries.

## Alternatives

**Retain the broad entrypoint and handbook.** Keeping shared policy there avoids
moving rules among references, but unrelated operations still load broad policy
and repeated rules need synchronized edits. Per-rule owners keep navigation
small and make each operational rule's authority explicit.

## Consequences

Consumers follow links to rule owners rather than loading the entire bundle.
Maintainers must preserve resolvable navigation and single ownership across all
fifteen files. Managed artifacts and structured intervention remain compatible
with general inline content and session-only execution history through explicit
exceptions. Scope, authorization, Goal confirmation, exact-version writes,
original-claim identity and repository delivery gates remain in force. This
reference-ownership decision does not establish runtime or platform qualification.
