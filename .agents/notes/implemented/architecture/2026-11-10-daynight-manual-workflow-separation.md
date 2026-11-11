# Agent Note: Separate the Daynight Manual, Repository Workflow, and Worker Contract

Status: implemented

## Problem

The public skill combined product operations with this repository's development
process and Worker execution rules. A second CLI manual duplicated product facts,
while Worker startup depended on workflow files bundled for a different purpose.
This imposed repository-specific procedures on other projects and made consistent
product guidance and independent Worker startup difficult to maintain.

## Decision

The public `using-daynight` skill owns product operations. The repository owns
its development process in
[development-workflow](../../../skills/development-workflow/SKILL.md), while
Worker execution constraints are compiled into its prompt builder. The builder
preserves the assigned identity and runtime boundaries without reading either
workflow or manual files. The target repository and actual authorization govern
its delivery policy.

At adoption, the public skill used a short entry and one complete manual copied
byte-for-byte into the bundle and `daynight --skill` resource. The
[topic-manual decision](2026-11-11-daynight-topic-manual.md) replaces that source
layout with independently readable topic files and a generated complete offline
manual. It retains this decision's product, repository and Worker ownership.

Local test guidance uses the assignment and its runtime constraints to verify
the original claim and completion, while the Worker architecture describes setup
probes and prompt assembly against the implementation. A running older Worker
retains its own package behavior across installation of a newer snapshot.

Required topics are validated as nonblank UTF-8 regular files, including their
heading and internal-link structure, before installation replaces any target.
Existing whole-directory replacement removes obsolete files.
This decision replaces the distribution and routing assumptions in the archived
[public skill design](../../archived/architecture/2026-10-21-public-agent-skill-design.md),
[mode routing](../../archived/architecture/2026-10-21-using-daynight-modes.md),
[managed skill](../../archived/architecture/2026-10-26-managed-task-skill.md), and
[CLI manual](../../archived/feature/2026-11-03-cli-skill-reading.md) decisions;
their original rationale remains historical.

## Alternatives

**Maintain two manuals.** Synchronization would leave two independently edited
sources and allow their product rules to diverge.

**Build a manual from multiple topic files.** The original separation rejected
assembly because it required maintaining an inventory and rewriting Markdown
links and anchors for two fixed consumers. A complete single-file source avoided
that machinery. The later topic-manual decision accepts those bounded costs to
support direct file-level reading from the skill entry.

**Read a bundled Worker runtime document.** Startup would retain a file, encoding,
and packaging dependency alongside assignment assembly. Compiled constraints
share the execution code's lifecycle and require no document I/O.

## Consequences

Both product entrypoints derive from one set of product topics and remain usable
without repository workflow files. The installed skill supports selective topic
reads, while the CLI prints a self-contained generated document. Worker prompt
text must be maintained and validated with code. Repository-specific confirmation,
handoff, review, and acceptance rules remain in the repository; managed-only
result requirements retain their original scope. No additional merge, publication,
or execution authority follows from these materials.
