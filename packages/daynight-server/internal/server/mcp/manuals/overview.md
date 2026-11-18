# Daynight MCP overview

Use `tools/list` for current tool definitions and `resources/list` to discover the product manual catalog. Read complete topics with `resources/read` and their absolute URIs. Reuse already-read guidance only while it remains applicable to the current operation.

| Purpose | Manual Resources |
| --- | --- |
| Establish Account/Team/Project context; resolve a repository | [concepts](daynight://manuals/concepts.md) |
| Create and organize Tasks/Goals; query projections, readiness, lifecycle or properties | [tasks](daynight://manuals/tasks.md) |
| Interpret graphs; create or replace dependencies | [dependencies](daynight://manuals/dependencies.md); [tasks](daynight://manuals/tasks.md) for creation rules |
| Interpret versions, authorization and write outcomes | [write-safety](daynight://manuals/write-safety.md) |
| Organize Goal outcomes/progress, requirements, accepted conclusions, references and results | [materials](daynight://manuals/materials.md) |
| Read or maintain ordered Steps | [steps](daynight://manuals/steps.md) |
| Read or post durable discussion | [threads](daynight://manuals/threads.md) |
| Read attachment metadata or complete bytes | [attachment-reads](daynight://manuals/attachment-reads.md) |
| Upload or remove attachments | [attachment-writes](daynight://manuals/attachment-writes.md); [attachment-reads](daynight://manuals/attachment-reads.md) if path rules are unknown |
| Observe activity/grouped work; locate Sessions; read history | [session-reads](daynight://manuals/session-reads.md) |
| Send to an exact Session; query or recover its original operation | [session-messages](daynight://manuals/session-messages.md); [session-reads](daynight://manuals/session-reads.md) if target identity is unknown |
| Hand off work or complete an explicit owned Worker claim | [worker-operations](daynight://manuals/worker-operations.md) |

A connection has no implicit current Project. Establish the intended target from an explicit ID or link, a verified Worker assignment, or host repository context; resolve a known repository address with `project_resolve`. Without target context, list Projects for explicit user selection. Task and Step summaries can omit full definitions; read full content when needed and attachments separately. Full Task lists still omit descriptions.

Before every write, read [write-safety](daynight://manuals/write-safety.md) and the current operation's topic. Documentation reads, status, assignment, readiness and automatic execution permission do not supply missing execution or delivery authorization or establish a Worker assignment. Apply the current user's scope and target project's rules. Preserve decision versions exactly; reassess conflicts and inspect completion facts before deciding on another submission.
