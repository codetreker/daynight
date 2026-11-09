Daynight provides tools for projects, tasks, Steps, discussion Threads and attachments. Use `tools/list` for the available tools and their input schemas.

Use `resources/list` to discover the product manuals, then call `resources/read` with a returned URI. Read the topics needed for the current operation: product concepts; queries and lifecycle; dependencies; safe writes; material organization; files and references; operation boundaries.

Establish the target Project from an explicit ID/link, a valid assignment or the host's repository context. Resolve a known `repoUrl` with `project_resolve` and use the returned Project ID; without target context, list Projects for an explicit user selection. A connection has no implicit current Project.

Task and Step reads default to summaries. Request complete content when a decision requires it, and read attachments separately. A full Task list still omits descriptions. Preserve the exact version used for a write decision; reassess conflicts and inspect write outcomes before deciding whether another submission is appropriate.

Reading documentation or task records does not start work, enable automation or establish a Worker assignment. Apply the current user's authorized scope and the target project's rules. Task status, responsibility and readiness describe the work; they do not supply missing delivery authorization.
