# Agent Note: Web Semantic Typography

Status: implemented

## Problem

Web pages use unrelated font sizes and reduce some text on narrow screens.
Reading, controls, and metadata need consistent roles, while browser font
preferences must remain effective without unexpectedly enlarging existing layouts.

## Decision

The Web entry stylesheet loads six shared `rem` roles defined in
[typography.css](../../../../packages/daynight-web/src/styles/typography.css).
The browser sets the root size and the body uses the interface role as its
baseline. The shared shell, selection controls, task filters, task rows,
personal task groups, Goal summaries, task search, Worker pages and
configuration, Worker Prompt editors, usage panels, and project settings use
semantic roles at all viewport widths. Selection text retains the existing
touch conditions and a 16 CSS px minimum; count badges use the metadata role.
The [UI standard](../../../../docs/ui-design.md#web-typography) owns role uses
and sizes. Touch fields use the shared `--text-touch-field` size to preserve a
16 CSS px minimum while responding to larger browser font preferences.

Business states, errors, controls, tool paths, and code use the interface role;
IDs, times, versions, and secondary counts use metadata. Feature-owned form
rules and explicit project dialog classes override the remaining shared legacy
form sizes, including Portal states, without changing unrelated consumers.
Narrow layouts wrap and rearrange controls, while dense panels retain local
scrolling where needed. Graph node usage text belongs to the graph layout and
retains that consumer's independent migration boundary.

Fixed geometry that depended on the former 14px root is independent of that root;
text-related spacing remains relative. The earlier
[root-independent layout decision](2026-11-19-web-root-independent-layout.md)
records the preparatory changes.

## Alternatives

**Keep a fixed root font size.** This would prevent the browser's default font
preference from controlling rem-based text and would retain the implicit link
between the root and unrelated geometry.

**Define sizes in each component.** This permits equal semantic roles to drift
and makes changing a reading size require edits across consumers.

## Consequences

The migrated consumers and inherited interface baseline respond to browser font
preferences; fixed layouts retain their intended geometry. Existing font sizes
in other feature consumers remain until those consumers migrate, so these shared
definitions and migrations do not establish whole-site consistency. Narrow
layouts must accommodate text without reducing its role size. Touch fields retain
their minimum readable size even when the browser's default font is smaller.
