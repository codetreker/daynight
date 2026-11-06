# Agent Note: Stable Mermaid diagrams share the Markdown reader

Status: implemented

## Problem

Markdown documents use multiple kinds of diagrams to communicate sequences,
relationships, plans and data. A reader restricted to flowcharts rejects valid
stored documents even though the pinned Mermaid SDK can render their diagrams.
Adding types must retain local failure isolation, readable dimensions, security
settings and resource ownership across the existing Markdown readers. Some
compact diagram inputs can cause disproportionate parser or calendar work.

## Decision

The shared Markdown diagram renderer accepts the 15 stable built-in types and
standard entries specified in the [requirements](../../../../docs/spec/daynight-task-inspection.md#markdown-图表).
An explicit policy checks both entry and SDK type and inspects each type's parsed
semantic data. Source and per-type structure limits bound ordinary diagrams;
Block's own lexer checks expansion before the parser constructs nodes. Before
rendering, the actual Block tree is limited to 50,000 estimated SDK sizing
calls; a version-scoped pnpm patch limits actual Gantt calendar steps across a
complete `getTasks()` compilation. The [design](../../../../docs/design/daynight-task-inspection.md#mermaid-图表)
owns the counts, reset boundaries and fixed-SDK integration.

The [original flowchart decision](../../archived/feature/2026-10-24-markdown-flowcharts.md) retains its
static image, shared queue, image-node refusal and lifecycle rationale. This
decision extends its type and budget policy. Output uses a positive finite root
viewBox to set intrinsic SVG image dimensions. Event Modeling's XHTML labels
remain in the static image; the application does not insert output SVG into the
reading DOM or install its callbacks. Flowchart defaults retain Dagre, while the
explicit stable `flowchart-elk` entry uses Mermaid's built-in ELK.

## Alternatives

**Accept every type registered by the SDK.** Registration includes experimental
and beta types, so it would silently expand the product's stability promise on
an SDK upgrade. Explicit entries and matching parser/render IDs keep the scope
and version boundary reviewable.

**Count only parsed Block nodes.** `space:N` allocates nodes while the parser
builds the DB, before a count could reject a small but expensive source. Reusing
the fixed SDK lexer distinguishes structural numbers from labels and comments
without duplicating its grammar.

**Remove the second Block sizing recursion.** The pinned SDK sizes children
twice per parent; removing the second pass changes the resulting layout because
it applies sibling dimensions. Bounding the predicted calls preserves SDK layout
semantics, at the cost of refusing some deeply nested diagrams that otherwise
meet the 500-node limit. This estimate bounds sizing calls, not all parser work;
the parser remains synchronous and subject to the source and expansion limits.
Reconsider the budget when the SDK layout changes.

**Estimate Gantt work from source or task count.** Date formats, excludes,
includes, task dependencies and compilation passes affect actual calendar work;
a short source with one task can traverse a very long date range. Limiting the
SDK's actual loop preserves those semantics and bounds the cumulative work.

**Render interactive SVG in the reader or shrink every chart to fit.** Live SVG
would expose callbacks and markup in the reading DOM; automatic shrinkage can
make wide charts unreadable. Static images with intrinsic dimensions and local
keyboard-accessible scrolling retain the reader's existing safety and legibility
properties.

## Consequences

All supported types share local state, source inspection and cleanup without
changing stored Markdown or its permissions. Image resources, experimental
types, third-party plugins and diagram interactions remain outside the scope;
static images do not provide selectable SVG text. The renderer is not a network
isolation mechanism.

Parser DB structures, the Block lexer, sizing-work estimate and Gantt patch are
tied to Mermaid 12.2.0. Upgrades must revalidate real parser data, Block layout
and its work estimate, the patch's actual npm root
entry and the bounded work and reset behavior. The type-specific policy and
browser-visible samples make that maintenance cost explicit.
