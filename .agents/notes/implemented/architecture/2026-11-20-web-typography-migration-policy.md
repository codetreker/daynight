# Agent Note: Web Typography Migration Policy

Status: implemented

## Problem

The shared size standard uses magnitude names, while existing Web modules select
purpose-based roles. Migrating every consumer together would combine unrelated
layout and renderer changes in one review. An unrestricted compatibility window
would let new role references and private sizes survive indefinitely.

## Decision

[typography.css](../../../../packages/daynight-web/src/styles/typography.css)
owns the six numeric sizes described by the [size-scale decision](2026-11-20-web-font-size-scale.md).
The transition initially retained six former role mappings to equal scale values,
a terminal bridge to `xs`, and a touch bridge using `max(var(--text-base), 16px)`.
These preserved computed sizes while modules migrated independently and replaced
the broad checking exceptions in the [semantic typography decision](2026-11-20-web-semantic-typography.md).
The bridges and temporary baseline have now been removed.

The checker inspects every production CSS and TypeScript source, including
unreferenced files, and rejects retired identifiers even in CSS geometry and
statically readable TypeScript strings and style operations. Mermaid font
configuration uses the measured-size adapter under a restricted source contract;
other font configuration values are rejected. The workspace shell, public
landing and setup pages, authentication styles, selection controls, Worker and
project configuration, Task and Goal views, graphs, charts, Markdown, Session
timelines, terminal recordings, Bot conversations and Assistant Task panels
select public sizes directly. The [Session and Bot typography decision](2026-11-20-session-bot-typography.md)
records terminal output's direct `sm` selection and input inheritance. Chart
plot geometry scales from `xs` and label rows use their computed line height;
graph geometry retains its independent root-size adaptation and view zoom.

The shared selection CSS owns touch text adjustments and sizes controls from
their actual text instead of private font aliases. Responsive input attributes use
two attribute selectors so the shared adjustment outranks generic field fonts
without changing their normal size. Consumers select the ordinary size on their
field container and retain local control geometry, including the Prompt editor's
196px minimum height. Management dialog fields and invitation secret text use the
shared responsive adjustment, while ordinary account tokens retain their inherited
size. Project and Task search inputs, Step editors, attachment paths and assignee
search use the shared coarse-pointer adjustment; the tag input derives its height
from its line box and padding with a 44px minimum. The [Web guide](../../../../packages/daynight-web/README.md#typography-validation)
owns commands and static-analysis limits. The [Markdown and Mermaid decision](2026-11-20-markdown-mermaid-typography.md)
records the independent SVG measurement boundary.

During migration, an exact baseline identified legacy occurrences by relative
path, category, normalized value, syntax context, count and module owner. New
occurrences, increased counts and stale entries failed the check, and collected
references required their retired definitions to remain present. Review required
module migrations to shrink their own entries. This bounded permission made the
compatibility window safe without permitting new uses, and the zero-legacy gate
identified when the temporary structure could be removed.

## Alternatives

**Replace every module together.** Equal renames alone do not verify terminal,
touch, Markdown and diagram behavior. Combining their changes makes independent
layout failures and review ownership harder to isolate.

**Keep permanent purpose aliases.** This leaves two selection vocabularies and
retains the coupling that the size-scale standard removes.

**Allow a file or configuration type during migration.** Such an exception also
admits newly introduced values. Exact occurrences and counts keep the permission
limited to the existing code while allowing formatting and line-number changes.

## Consequences

Modules migrated independently against one numeric source without making the
compatibility aliases permanent. The production checker now admits no legacy
occurrences or exemption baseline. It cannot execute arbitrary runtime code or
prove browser rendering; production-browser measurements remain necessary at
renderer boundaries.
