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
baseline. The shared shell, selection controls, task filters and rows, personal
task groups, Goal summaries, task search, Markdown reading surfaces, dependency
graphs, project overview, statistics, Worker pages and configuration, Worker
Prompt editors, usage panels, project settings, teams, GitHub integration, pull
requests, and Webhooks use semantic roles at all viewport widths. Selection text
retains the existing touch conditions and a 16 CSS px minimum; count badges use
the metadata role. Markdown code and tables use the interface role; Bot
first-paragraph emphasis retains its weight without a separate size. The
[UI standard](../../../../docs/ui-design.md#web-typography)
owns role uses and sizes. Touch fields use the shared `--text-touch-field` size
to preserve a 16 CSS px minimum while responding to larger browser font preferences.

Business states, errors, controls, tool paths, and code use the interface role;
IDs, times, versions, and secondary counts use metadata. Feature-owned form
rules and explicit project dialog classes override the remaining shared legacy
form sizes, including Portal states, without changing unrelated consumers.
Narrow layouts wrap and rearrange controls, while dense panels retain local
scrolling where needed. Webhook detail tabs wrap within the available panel width
so increased browser fonts do not hide navigation. Graph layout coordinates grow
with the root font size so fixed node boxes accommodate text independently of
graph zoom. Overview progress rows rearrange at narrow widths; chart axes preserve
horizontal scrolling and provide room for enlarged labels.

Fixed geometry that depended on the former 14px root is independent of that root;
text-related spacing remains relative. The earlier
[root-independent layout decision](2026-11-19-web-root-independent-layout.md)
records the preparatory changes.

## Alternatives

**Keep a fixed root font size.** This would prevent the browser's default font
preference from controlling rem-based text and would retain the implicit link
between the root and unrelated geometry.

**Keep the smaller fixed graph cards.** Larger labels and actions would collide or
be clipped, especially when the browser font preference increases. Scaling the
node geometry costs canvas space and can reduce the initial zoom on narrow screens.

**Define sizes in each component.** This permits equal semantic roles to drift
and makes changing a reading size require edits across consumers.

## Consequences

The migrated consumers and inherited interface baseline respond to browser font
preferences; fixed layouts retain their intended geometry. Existing font sizes
in other feature consumers remain until those consumers migrate, so these shared
definitions and migrations do not establish whole-site consistency. Narrow
layouts must accommodate text without reducing its role size. Touch fields retain
their minimum readable size even when the browser's default font is smaller.
