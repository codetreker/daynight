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
baseline. The shared shell, selection controls, task filters, and Markdown
reading surfaces use the semantic roles at all viewport widths. Selection text
retains the existing touch conditions and a 16 CSS px minimum; count badges use
the metadata role. Markdown code and tables use the interface role; Bot
first-paragraph emphasis retains its weight without a separate size.
The [UI standard](../../../../docs/ui-design.md#web-typography) owns role uses
and sizes. Fixed geometry that depended on the former 14px root is independent
of that root; text-related spacing remains relative. The earlier
[root-independent layout decision](2026-11-19-web-root-independent-layout.md)
records the preparatory changes.

## Alternatives

**Keep a fixed root font size.** This would prevent the browser's default font
preference from controlling rem-based text and would retain the implicit link
between the root and unrelated geometry.

**Define sizes in each component.** This permits equal semantic roles to drift
and makes changing a reading size require edits across consumers.

## Consequences

The shell, Markdown reading surfaces, and inherited interface baseline respond
to browser font preferences; fixed layouts retain their intended geometry.
Existing feature-specific font sizes remain until those consumers migrate, so the shared definitions alone do
not establish whole-site consistency. Narrow layouts must accommodate text
without reducing its role size.
