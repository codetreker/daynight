# Daynight MCP overview

Read this overview before using Daynight tools. Use `tools/list` for current input contracts, `resources/list` for the manual catalog, and `resources/read` for complete topics at their absolute URIs. Read the required topics in full; reuse already-read guidance while it still applies. Rediscover and reread current guidance after a server update. A topic link marked conditional is needed when that condition applies, not for every operation.

## Choose the reading set

| Operation | Required topic; conditional additions |
| --- | --- |
| Establish Account, Team or Project context; resolve a repository | [Concepts](daynight://manuals/concepts.md) |
| Inspect Tasks/Goals, list ready work or read properties | [Task reads](daynight://manuals/tasks.md) |
| Create or delete Tasks/Goals, or change metadata, status or properties | [Task writes](daynight://manuals/task-writes.md); [Materials](daynight://manuals/materials.md) when defining or replacing formal material; [Dependencies](daynight://manuals/dependencies.md) when setting relationships |
| Read a dependency graph | [Dependencies](daynight://manuals/dependencies.md) |
| Replace or reduce dependency relationships | [Dependencies](daynight://manuals/dependencies.md) |
| Organize requirements, designs, shared sources or results | [Materials](daynight://manuals/materials.md) |
| Read or maintain Steps | [Steps](daynight://manuals/steps.md) |
| Read or post participant discussion | [Threads](daynight://manuals/threads.md) |
| Read attachment metadata/bytes or resolve paths | [Attachment reads](daynight://manuals/attachment-reads.md) |
| Publish or remove attachments | [Attachment writes](daynight://manuals/attachment-writes.md); Attachment reads for unknown path rules or reading back bytes |
| Observe ongoing work, locate or inspect Sessions | [Session reads](daynight://manuals/session-reads.md) |
| Read Session history or complete entries | [Session reads](daynight://manuals/session-reads.md) |
| Send to an exact Session or query its original operation | [Session messages](daynight://manuals/session-messages.md); Session reads when target identity, state or admission must be established |
| Hand off work or complete an explicitly owned Worker claim | [Worker operations](daynight://manuals/worker-operations.md) |

Every write also requires [Write safety](daynight://manuals/write-safety.md) and its operation-specific prerequisites. Topics state any further necessary reads. For an input-dependent decision, read the actual complete material, not only its inventory or a preview. Task/Step summaries omit definitions; even full Task lists omit descriptions. Attachments, Steps, Thread and Session content are separate reads.

## Shared conventions

A connection has no implicit current Project. Establish the target from an explicit ID/link, a verified runtime assignment or the host repository; resolve a known repository with `project_resolve`. Without target context, list Projects for explicit user selection. Concepts owns identity and ambiguity rules.

Business results are in `structuredContent.data`; success metadata is in `structuredContent.meta`. Tool execution errors have `isError: true` and `structuredContent.error`. In these guides, `data`, `meta` and `error` refer to those paths. A protocol failure may lack that envelope. The short `Completed.` text is not the business result. Input declarations do not describe every result field, default, limit or behavioral condition; the operation topic supplies those facts.

Examples using symbols such as P (Project), T (Task), A/B/X (related Tasks) or S (Session) are schematic, not executable JSON. Substitute actual observed IDs, exact versions and required scope when making calls. Complete JSON examples, where present, also use fictional identities.

Reading guidance, Task status, responsibility, readiness and automatic permission do not establish execution/delivery authority or a Worker assignment. Apply current user authorization and project rules. Preserve exact decision versions; reread and reassess conflicts, and interpret completion facts before any new submission. Write safety owns these rules; each operation owns its particular identity and recovery procedure.
