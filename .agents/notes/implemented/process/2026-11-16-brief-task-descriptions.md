# Agent Note: Brief Task and Goal descriptions

Status: implemented

## Problem

Long descriptions make it difficult to find the outcome and scope of a Task or
Goal, while detailed requirements and evidence still need a readable owner.
Readers also need complete definitions and acceptance criteria for small tasks
without being forced to create an extra file.

## Decision

The Assistant prompt, CLI and MCP product guidance describe Task and Goal
descriptions as brief overviews with references to detailed material. Full
requirements, solutions, designs, implementation instructions, reports and
acceptance evidence belong in the owning attachments. A simple task can be
complete in a few sentences without an attachment. The guidance sets no fixed
length target and does not change storage limits or migrate existing content.
Definitions and acceptance remain complete across the description and its
readable material; Goal ownership and execution rules remain independent.

## Alternatives

**Allow detailed descriptions alongside attachments.** The earlier
[content-sufficient handoff decision](../../archived/process/2026-10-25-task-content-handoff.md)
avoided mandatory files for complete descriptions. Allowing lengthy material in
the overview also makes the task's purpose harder to scan. The simple-task
exception retains the benefit without duplicating long material.

## Consequences

Detailed materials need an attachment and an accurate reference; readers must
read it to assess completeness. The repository's
[workflow material references](2026-11-16-workflow-material-references.md)
apply this guidance while retaining its own content and stage requirements.
This is writing guidance rather than a new API validation or automatic content
transformation. Existing Assistant roles retain their frozen instructions, while
newly prepared roles use the updated revision.
