Daynight provides MCP tools for Projects, Tasks/Goals, Steps, Threads, attachments, Bots and Session observations. Use `tools/list` for current tool schemas; use `resources/list` to discover the current product manual catalog and `resources/read` with a returned URI. Read complete required topics, reusing already-read guidance only while it remains applicable. Every write requires write-safety plus the operation's resource-specific conditions.

| Purpose | Manual Resource name |
| --- | --- |
| Establish Account/Team/Project context; resolve a repository | concepts |
| Create and organize Tasks/Goals; query projections, readiness, lifecycle or properties | tasks |
| Interpret graphs; create or replace dependencies | dependencies; tasks for creation rules |
| Interpret versions, authorization and write outcomes | write-safety |
| Organize Goal outcomes/progress, requirements, accepted conclusions, references and results | materials |
| Read or maintain ordered Steps | steps |
| Read or post durable discussion | threads |
| Read attachment metadata or complete bytes | attachment-reads |
| Upload or remove attachments | attachment-writes; attachment-reads if path rules are unknown |
| Observe activity/grouped work; locate Sessions; read history | session-reads |
| Send to an exact Session; query or recover its original operation | session-messages; session-reads if target identity is unknown |
| Hand off work or complete an explicit owned Worker claim | worker-operations |

A connection has no implicit current Project. Establish the intended target from an explicit ID/link, a verified assignment or host repository context; resolve a known repository address with `project_resolve`. Without target context, list Projects for explicit user selection. Task/Step summaries omit full definitions; read full content when needed and attachments separately. Full Task lists still omit descriptions.

Documentation reads, status, assignment, readiness and automatic permission do not supply missing execution or delivery authorization or establish a Worker assignment. Apply the current user's scope and target project's rules. Preserve decision versions exactly; reassess conflicts and inspect completion facts before deciding on another submission.
