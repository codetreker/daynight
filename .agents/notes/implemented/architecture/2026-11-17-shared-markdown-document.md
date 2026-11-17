# Agent Note: Shared Markdown document renderer

Status: implemented

## Problem

Task, Goal, Steps and attachment readers need consistent Markdown and diagram
behavior while resolving resources against different attachment roots. A reader
that owns both syntax and task-specific navigation cannot be independently used
by another document surface. Duplicated parser and presentation logic also makes
security, footnote isolation and accessible overflow harder to maintain.

## Decision

`MarkdownView` owns document parsing, common nodes, styles, localized labels and
the single Mermaid renderer. Its document resource policy delegates URL resolution,
link activation and image rendering to the caller. `MarkdownContent` adapts task
and attachment resources while retaining their navigation, pause and retry owners.
The [shared design](../../../../docs/design/shared-markdown.md) records the source
and checked URL distinction, footnote isolation and asynchronous diagram rules.
Chat keeps its existing separate renderer and resource policy.

The archived [description decision](../../archived/architecture/2026-10-22-task-description-markdown.md)
retains the original shared task-reader and attachment-base rationale. This decision
separates that reader's common syntax from its business resource adaptation. The
[image retry](../feature/2026-11-16-markdown-attachment-image-retry.md) and
[stable diagrams](../feature/2026-11-05-stable-mermaid-diagrams.md) decisions
continue to own their respective behavior and trade-offs.

## Alternatives

**Move the task reader unchanged.** It would retain the dependency on attachment
models and navigation, making a public component require task-specific knowledge.

**Share styles alone.** Parser, footnote, node and diagram behavior would remain
separate, allowing the same syntax and safety rules to diverge.

**Expose arbitrary plugins and node replacements.** Callers could redefine URL
safety, footnote isolation and diagram lifecycle, removing the common owner's
guarantees. A fixed document policy with resource callbacks covers its consumers.

## Consequences

Document consumers share syntax, local scrolling and diagram policy without
transferring their resource or interaction ownership. The component must preserve
both normalized source and checked display URL; a rejected URL cannot become an
image source through the original reference. Mermaid's global SDK state still
requires one serialized queue. Chat remains independent and retains its own
semantics and visual rules until its consumers adopt a complete shared policy.
