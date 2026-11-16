# Agent Note: Workflow material references

Status: implemented

## Problem

Repository task instructions allowed a complete definition in the description
and required every delivery description to contain its full architecture source
index. Finding packages also copied their complete task definition into that
field. These requirements compete with the product's
[material guidance](2026-11-16-brief-task-descriptions.md) and make an overview
carry implementation detail even when complete attachments already exist.

## Decision

The product materials manual owns description and attachment usage. The
[task content standard](../../../skills/development-workflow/references/task-content.md)
defines completeness across the Task's own material and readable sources. Goal
delivery briefs retain direct producer, Goal and exact source references; their
source index can live in an attachment reached from the Task description.
Stage gates, shared ownership and delivery requirements retain their scope.

Finding packages use the existing manifest's `description` file for the overview
and list the complete task definition in `supportingFiles`. Remote review
compares the overview with the description and verifies every required attachment
against its local bytes. Local validation checks links in Markdown attachments
from their document directory, while description links use the attachment root.
Both resolve only to inventoried resources within that root.

## Alternatives

**Repeat the product rule in workflow instructions.** Independent copies would
create more places to reconcile when the product's writing guidance changes.
The workflow instead keeps its content and phase requirements and links to the
product owner for storage conventions.

**Move the definition file and keep description-only link checks.** Byte checks
would still detect missing or changed files, but broken links inside the moved
definition would escape the existing resource check. Document-relative
validation preserves that guarantee after the move.

## Consequences

Task definitions and acceptance remain complete without duplicating long content
or indexes in the overview. Finding packages retain their manifest format and
remote byte comparison. Their local validator handles the two existing Markdown
link bases without becoming a general Markdown processor or changing product
storage, old task content or execution authority.
