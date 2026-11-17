# Agent Note: Shared Markdown renderer

Status: implemented

## Problem

Task, Goal, Steps, attachment and chat readers need consistent Markdown and
diagram behavior while retaining distinct resource permissions and reading
semantics. A reader that owns both syntax and task-specific navigation cannot be
independently used by another surface. Duplicated parser and presentation logic
also makes security, footnote isolation and accessible overflow harder to maintain.

## Decision

`MarkdownView` owns parsing, common nodes, styles, localized labels and the single
Mermaid renderer. Its document policy delegates URL resolution, link activation and
image rendering to the caller. `MarkdownContent` adapts task and attachment
resources while retaining their navigation, pause and retry owners. The chat
policy preserves visible soft breaks and restricted links; controlled image
callbacks receive ranges, alt text and presentation after binding-set validation,
never source URLs.
`ChatMarkdown` adapts scene labels and Session retains its independent resource
admission and lifecycle. The [shared design](../../../../docs/design/shared-markdown.md)
records these boundaries, footnote isolation and asynchronous diagram rules.

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
guarantees. Fixed document and chat policies with resource callbacks cover the
actual consumers without exposing those internals.

## Consequences

Consumers share syntax, local scrolling and diagram policy without transferring
their resource or interaction ownership. The component must preserve both
normalized document source and checked display URL; a rejected URL cannot become
an image source through the original reference. Chat range validation prevents
a mismatched binding from rendering but does not confer Session resource access.
Mermaid's global SDK state requires one serialized queue. Shared style parameters
preserve the existing chat reading density without duplicating node skins.
