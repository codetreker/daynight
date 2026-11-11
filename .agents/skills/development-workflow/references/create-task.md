# Create task

Prepare and register authorized work, then return without automatic execution.
Apply [authorization and scope](authorization.md) first, find commands in the [CLI handbook](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/setup-and-projects.md#setup), and prepare content under the [task content standard](task-content.md).

## Select and check for duplicates

Use one task per independently tracked result under the [task content standard](task-content.md). For multi-stage objectives, follow the [Goal protocol](goal.md) and register only the currently permitted stage.
See [final acceptance](final-acceptance.md) for the scope and results of independent acceptance tasks. Do not register routine execution steps as separate tasks.

Confirm the [target project](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/setup-and-projects.md#project-discovery) and search for existing work on the same problem and scope, including completed tasks.
Read full descriptions, actual sources, dependencies, and acceptance criteria before deciding to reuse a task; similar titles do not establish identity.
After an interruption, verify existing resources before creating anything again.

## Prepare content

Write an outcome-oriented title and a task-specific Markdown description that meet the content standard and current stage requirements. Prepare each delivery task's problem, selected solution, detailed design, ordered implementation steps and acceptance criteria under [definitions and results](task-content.md#definitions-and-results). For each Goal delivery task, also prepare its [delivery task brief](goal.md#delivery-task-brief), including its contribution to the Goal.
Registration and handoff remain separate operations; incomplete task definition prevents passing the [delivery handoff threshold](task-content.md#content-sufficiency).
Genuinely required sources must be readable, and future outputs must be explicitly assigned to prerequisite tasks.
Keep shared inputs in their owning tasks; do not copy the full set of material.

Frontend delivery requires an interactive prototype that runs entirely on the frontend and matches the final visual style, covering applicable populated, empty, loading, failure, disabled, long-content, and narrow-screen states.
Include all resources with valid references, and view and actually interact with the prototype. Static sketches or simplified styling do not satisfy the requirement.
A discussion task that produces a prototype treats it as a result, not a prerequisite for starting.

Mock UI data and interaction state must remain only in the current page's memory.
Do not use storage mechanisms such as `localStorage`, `sessionStorage`, Cookie, or IndexedDB, or perform other operations that persistently change local state; dependency libraries must not perform these operations indirectly either.
Reloading or reopening the prototype must restore its initial state.

Select necessary direct prerequisites under [dependency classification and reduction](dependencies.md#dependency-reduction), verifying whether they belong to the same chain or another chain.
Do not add dependencies for visual grouping or duplicate the full relationship list in the body.

## Choose the operating system

Set `requiredPlatform` from the environment genuinely needed to implement or
verify the task:

| Value | Selection rule |
| --- | --- |
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

## Register and read back

1. Register with `task create` and retain the returned ID. New task status and permissions follow [task management](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/tasks.md#queries). Creation defaults to proposed; explicitly pass `--status todo` for already-confirmed work, including internal multi-step tasks.
2. If the task owns attachments, upload and verify their content before adding actual references to the description. Follow [write safety](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/write-safety.md) for all writes.
3. Read back the full task, required attachments, and shared inputs to verify sufficient content and valid resources. For delivery tasks, check the selected solution, detailed design, implementation steps and acceptance against the content standard; report concrete gaps before handoff.
   Check dependencies through [post-change verification](dependencies.md#verify-dependency-changes).
   For Goal delivery items, verify the [four-part brief](goal.md#delivery-task-brief) against the confirmed Goal and accepted solution, and apply the [whole-breakdown checks and architecture source index](goal.md#register-the-delivery-breakdown).
4. Report the task ID, registration result, and specific gaps.
   After partial success, retain existing IDs and resume unfinished operations; unreadable required sources still mean failure.

A registration-only request ends here, with the task retaining its selected creation status: proposed by default, or todo when that confirmed work was explicitly registered as todo.
When explicitly asked to start the current Goal discussion, pass the confirmed ID to [ordinary task execution](run-task.md) under the Goal protocol.
