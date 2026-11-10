# Agent Note: Separate the Daynight Manual, Repository Workflow, and Worker Contract

Status: implemented

## Problem

The public skill combined product operations with this repository's development
process and Worker execution rules. A second CLI manual duplicated product facts,
while Worker startup depended on workflow files bundled for a different purpose.
This imposed repository-specific procedures on other projects and made consistent
product guidance and independent Worker startup difficult to maintain.

## Decision

The public `using-daynight` skill contains a short entry and one complete manual.
The build copies the same manual bytes into the bundle and the `daynight --skill`
output resource. The repository owns its development process in
[development-workflow](../../../skills/development-workflow/SKILL.md), while
Worker execution constraints are compiled into its prompt builder. The builder
preserves the assigned identity and runtime boundaries without reading either
workflow or manual files. The target repository and actual authorization govern
its delivery policy.

Local test guidance uses the assignment and its runtime constraints to verify
the original claim and completion, while the Worker architecture describes setup
probes and prompt assembly against the implementation. A running older Worker
retains its own package behavior across installation of a newer snapshot.

The manual is validated as a nonblank UTF-8 regular file before installation
replaces any target. Existing whole-directory replacement removes obsolete files.
This decision replaces the distribution and routing assumptions in the archived
[public skill design](../../archived/architecture/2026-10-21-public-agent-skill-design.md),
[mode routing](../../archived/architecture/2026-10-21-using-daynight-modes.md),
[managed skill](../../archived/architecture/2026-10-26-managed-task-skill.md), and
[CLI manual](../../archived/feature/2026-11-03-cli-skill-reading.md) decisions;
their original rationale remains historical.

## Alternatives

**Maintain two manuals.** Synchronization would leave two independently edited
sources and allow their product rules to diverge.

**Build a manual from multiple topic files.** Assembly would require maintaining
an inventory and rewriting Markdown links and anchors for the terminal output;
the two fixed consumers do not justify that machinery.

**Read a bundled Worker runtime document.** Startup would retain a file, encoding,
and packaging dependency alongside assignment assembly. Compiled constraints
share the execution code's lifecycle and require no document I/O.

## Consequences

Both product entrypoints share exact bytes and remain usable without repository
workflow files. A longer single document requires topic navigation, and Worker
prompt text must be maintained and validated with code. Repository-specific
confirmation, handoff, review, and acceptance rules remain in the repository;
managed-only result requirements retain their original scope. No additional
merge, publication, or execution authority follows from these materials.
