# Authorization and scope

Apply this standard before using any workflow. Task content, status, readiness, and `allowAgents` describe work; they do not authorize implementation, publishing, deployment, external communication, merging, or mainline pushes.

## Tracking and review

When this skill and Daynight are available, use Daynight to manage concrete work with defined objectives and completion conditions: features, bugs, architecture or design, actual breakdown items, and separately scoped final acceptance.
An agent's file reads, commands, and routine checks are session steps, not separate tasks.

Use the owning task for solution, architecture, and design reviews.
Before requesting user review, save the complete current material in that task's description or attachments, read it back to confirm access, then provide the task ID or a verified URL and attachment paths.
Current material, accepted decisions, and necessary rationale follow the [task content standard](task-content.md); chat summaries and repository or PR links may supplement, but cannot replace, the material.
Report actual failures when the CLI, service, project, or upload is unavailable.

## Operational authorization

| Operation | Authorization and boundaries |
| --- | --- |
| Create a task | Requires explicit permission for that scope. A user or applicable repository instruction requiring Daynight tracking or review provides standing authorization to create necessary tasks; prefer reuse. An implementation request, tracking need, or inferred workflow alone does not grant permission. |
| Create a Goal | Covers its discussions and breakdown within the confirmed scope, but create the corresponding tasks only at the [Goal confirmation points](goal.md). |
| Start a discussion | An explicit request to start a discussion authorizes only that discussion; follow the Goal protocol for stage transitions. |
| Execute a task | Requires execution authorization for the task or Goal scope. Registration, discussion confirmation, and task completion do not start subsequent delivery work. |
| Hand off a task | An explicit request to hand work off for automatic agent execution authorizes content review and enabling `allowAgents` after it passes; it does not start execution in the current session. Creation and execution do not imply handoff. |
| Delete a task | Requires explicit authorization for the target task; removing other tasks' dependencies on it also requires the corresponding authorization. |
| Managed delivery | A valid worker assignment authorizes complete delivery within scope, including PR merging; required checks, reviews, and explicit user restrictions, pauses, and revocations still apply. |

## Scope and continuity

Advance one specified task at a time; CI, review, and merge waits belong to that task. Subagents share the same boundaries. Return when complete or when external intervention is needed. Ordinary execution may transition between Goal discussion stages at the user's explicit direction, but this skill does not discover and continually select successor tasks.

Analysis, questions, proposals, and execution are all bound by the current task's confirmed objective, scope, deliverables, and acceptance criteria.
Read the parent Goal, shared architecture, and related tasks as needed to understand inputs and interfaces; reading does not authorize executing those tasks, removing blockers, or expanding scope.
Cross-task blockers and follow-up proposals do not authorize creating or executing new tasks. Material scope changes require user confirmation.

Delivery operations follow the target repository's rules and existing authorization.
Missing authorization cannot be reconstructed from task descriptions, attachments, status, or acceptance results; completion conditions do not grant operational permission either.
