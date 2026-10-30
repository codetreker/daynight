# Create task

Prepare and register authorized work, then return without automatic execution.
Apply [authorization and scope](authorization.md) first, find commands in the [CLI handbook](handbook.md), and prepare content under the [task content standard](task-content.md).

## Select and check for duplicates

Use one task per independently tracked result. For multi-stage objectives, follow the [Goal protocol](goal.md) and register only the currently permitted stage.
See [final acceptance](final-acceptance.md) for the scope and results of independent acceptance tasks. Do not register routine execution steps as separate tasks.

Confirm the [target project](project-management.md) and search for existing work on the same problem and scope, including completed tasks.
Read full descriptions, actual sources, dependencies, and acceptance criteria before deciding to reuse a task; similar titles do not establish identity.
After an interruption, verify existing resources before creating anything again.

## Prepare content

Write an outcome-oriented title and a task-specific Markdown description that meet the content standard and current stage requirements.
Genuinely required sources must be readable, and future outputs must be explicitly assigned to prerequisite tasks.
Keep shared inputs in their owning tasks; do not copy the full set of material.

Frontend delivery requires an interactive prototype that runs entirely on the frontend and matches the final visual style, covering applicable populated, empty, loading, failure, disabled, long-content, and narrow-screen states.
Include all resources with valid references, and view and actually interact with the prototype. Static sketches or simplified styling do not satisfy the requirement.
A discussion task that produces a prototype treats it as a result, not a prerequisite for starting.

Mock UI data and interaction state must remain only in the current page's memory.
Do not use storage mechanisms such as `localStorage`, `sessionStorage`, Cookie, or IndexedDB, or perform other operations that persistently change local state; dependency libraries must not perform these operations indirectly either.
Reloading or reopening the prototype must restore its initial state.

Select necessary direct prerequisites under [dependency classification and reduction](task-management.md#dependency-classification), verifying whether they belong to the same chain or another chain.
Platform requirements must come only from confirmed task needs. Do not add dependencies for visual grouping or duplicate the full relationship list in the body.

## Register and read back

1. Register with `task create` and retain the returned ID. New task status and permissions follow [task management](task-management.md).
2. If the task owns attachments, upload and verify their content before adding actual references to the description. Follow [write safety](write-safety.md) for all writes.
3. Read back the full task, required attachments, and shared inputs to verify sufficient content and valid resources.
   Check dependencies through [post-change verification](task-management.md#verify-dependency-changes).
   For Goal delivery items, also check the [architecture source index](goal.md#register-the-delivery-breakdown).
4. Report the task ID, registration result, and specific gaps.
   After partial success, retain existing IDs and resume unfinished operations; unreadable required sources still mean failure.

A registration-only request ends here, with the task remaining `todo`.
When explicitly asked to start the current Goal discussion, pass the confirmed ID to [ordinary task execution](run-task.md) under the Goal protocol.
