# Agent Note: Web Typography Migration Policy

Status: implemented

## Problem

The shared size standard uses magnitude names, while existing Web modules select
purpose-based roles. Migrating every consumer together would combine unrelated
layout and renderer changes in one review. An unrestricted compatibility window
would let new role references and private sizes survive indefinitely.

## Decision

[typography.css](../../../../packages/daynight-web/src/styles/typography.css)
owns the six numeric sizes. The six former roles point to equal scale values;
the terminal bridge points to `xs`, and the touch bridge uses
`max(var(--text-base), 16px)`. Unmigrated consumers retain their computed sizes.
This introduces the foundation of the [size-scale proposal](../../proposed/architecture/2026-11-20-web-font-size-scale.md)
without treating the remaining consumer migration as delivered. It replaces the
broad checking exceptions recorded in the [semantic typography decision](2026-11-20-web-semantic-typography.md).

Strict CSS and TypeScript AST inspection runs across every production source,
including unreferenced files. A checked-in migration baseline records exact
legacy occurrences by relative path, category, normalized value, syntax context,
count and module owner. Only those occurrences receive temporary permission.
New occurrences, increased counts and stale entries fail the check. Module
migrations may only remove or reduce their own entries; review verifies that
baseline diffs only shrink. The production check never expands the baseline.
Collected references also require their retired definitions to remain present;
deleting a definition and its baseline entry cannot strand unmigrated consumers.

Retired identifiers are tracked independently of font declarations, including
CSS geometry and statically readable TypeScript strings and style operations.
Mermaid's current configuration receives individual entries, so its surrounding
files and configuration objects retain normal inspection. The workspace shell, public landing and setup pages, authentication styles and
shared selection controls use the public sizes directly; the shared selection CSS
owns touch text adjustments and sizes controls from their actual text instead of
private font aliases. Management dialog fields and invitation secret text use the shared responsive
touch adjustment, while ordinary account tokens retain their inherited size. The zero-legacy mode refuses the bridge and all remaining baseline
uses, supplying the closing migration gate. The [Web guide](../../../../packages/daynight-web/README.md#typography-validation)
owns commands and static-analysis limits.

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

Modules can migrate independently against one numeric source, with an explicit
owner for each remaining use. Removing or changing a legacy use requires updating
its baseline entry in the same change. The bridge and baseline add temporary
maintenance cost and must disappear when all consumers have migrated. The
checker cannot execute arbitrary runtime code or prove browser rendering;
production-browser measurements remain necessary at renderer boundaries.
