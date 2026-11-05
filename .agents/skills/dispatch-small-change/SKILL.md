---
name: dispatch-small-change
description: Turn a bounded repository change request into a clear Daynight task, choose its required operating system, and hand it off to a Worker. Use for preparing and dispatching a small change, preserving discussion-only or registration-only requests.
---

# Dispatch Small Change

Prepare one independently verifiable change and hand it to the existing
Daynight Worker workflow. Successful handoff and readback complete this skill;
the Worker owns implementation and subsequent delivery.

Use the repository's [using-daynight skill](../../../packages/daynight/src/commands/skill/skills/using-daynight/SKILL.md)
for setup, task creation, content, write safety and handoff. Follow repository
language, documentation, decision-note, prototype and delivery requirements.

## Understand and bound the change

Read the relevant implementation and requirements before forming the task.
Establish the trigger, observed behavior, intended result and affected callers.
Separate verified facts from suspected causes; do not turn an unverified patch
idea into a required implementation.

Small means a single outcome with clear boundaries and observable acceptance.
File count, line count and request length do not establish that boundary. Resolve
consequential product, contract, migration or architecture decisions before
handoff. Ask necessary questions together after investigating what the repository
can answer. Routine implementation choices stay with the implementing agent.
When the work requires a multi-stage Goal, follow the existing Goal workflow.

Apply the [creation workflow](../../../packages/daynight/src/commands/skill/skills/using-daynight/references/create-task.md),
including project selection and duplicate checks across unfinished and completed
work. Read the full candidate task, sources, dependencies and acceptance criteria
before reusing it. Preserve active work and ownership; a similar title is not
enough to reuse or create a replacement. Completed matching work needs no new
dispatch unless the request establishes a distinct remaining problem.

## Prepare an executable task

Write an outcome-oriented title and enough content for an implementer without
the original conversation. Apply the [task content standard](../../../packages/daynight/src/commands/skill/skills/using-daynight/references/task-content.md)
using the following information where applicable, without empty template fields:

| Information | Required substance |
|---|---|
| What | Trigger, current behavior, expected behavior and affected consumers. |
| Why | Actual impact and the reason the behavior needs to change. |
| Scope | The independently delivered result, affected boundaries and behavior that must remain valid. |
| How | Confirmed solution direction, existing mechanisms and necessary technical constraints; required designs when the work depends on them. |
| Sources | Readable requirements, code and attachments with their purposes; verified immutable revisions for repository inputs. |
| Verify | Observable success and failure behavior, important regressions, applicable checks and delivery completion conditions. |

Keep command sequences, tool choices, worktree paths and execution history in
the Session. An unknown root cause may remain an investigation responsibility
when the required result and verification are clear; unresolved target behavior
or acceptance criteria cannot be supplied by guesswork.

## Choose the operating system

Set `requiredPlatform` from the environment genuinely needed to implement or
verify the task, using the existing [task metadata](../../../packages/daynight/src/commands/skill/skills/using-daynight/references/task-management.md#metadata):

| Value | Selection rule |
|---|---|
| `null` (Any platform) | No particular OS is needed to implement and verify the required result. |
| `windows` | Native Windows behavior, tools or verification are required. |
| `linux` | Native Linux behavior, tools or verification are required. |
| `macos` | Native macOS behavior, tools or verification are required. |

Record the reason for an OS restriction. Use task evidence, not the current
machine or the mere mention of an OS in a report. A generic message correction
can be unrestricted; verifying a native Windows installer failure may require
Windows. WSL's Linux runtime is Linux. Agent provider, model and Worker identity
are separate from this field.

For verification spanning operating systems, establish how the executor can
obtain all required evidence, including suitable existing CI where applicable.
If no single execution environment can satisfy it, clarify the verification or
task boundaries before handoff; one platform value cannot express an OS set.

## Register, hand off and return

Respect the user's requested operation under [authorization and scope](../../../packages/daynight/src/commands/skill/skills/using-daynight/references/authorization.md).
Discussion stays discussion; a registration-only request ends after verified
registration. Discovering or reading this skill does not authorize mutations.
When the user requests automatic handoff and inputs are sufficient, continue
through preparation, registration, review and handoff without a redundant
confirmation between those operations.

Register or update within the confirmed scope using the creation workflow and
[write safety](../../../packages/daynight/src/commands/skill/skills/using-daynight/references/write-safety.md).
New tasks begin with automatic execution disabled. Set and verify the platform
during preparation; changing an existing task must respect its state and scope.
Read back the complete task and genuinely required resources before handoff.

Apply the [handoff workflow](../../../packages/daynight/src/commands/skill/skills/using-daynight/references/handoff.md)
to that task ID. Its content and independently authenticated responsibility
checks, state restrictions, exact-version write and final reconciliation govern
enablement. Preserve assignment, status, dependencies and Worker history; report
gaps through that workflow rather than bypassing them. A completed or already
active task follows its existing state-specific handling.

Return the task reference, preparation and handoff conclusions, observed
version, assignee, platform, permission, status, dependency blockers and any
Worker ownership. Distinguish confirmed writes from uncertain outcomes.
`allowAgents=true` proves permission, not agent startup or delivery. After a
successful verified handoff, return without waiting for a claim, starting a
local implementation or selecting more work.
