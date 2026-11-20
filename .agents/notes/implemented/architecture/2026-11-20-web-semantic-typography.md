# Agent Note: Web Semantic Typography

Status: implemented

## Problem

Web pages use unrelated font sizes and reduce some text on narrow screens.
Reading, controls, and metadata need consistent roles, while browser font
preferences must remain effective without unexpectedly enlarging existing layouts.

This note records the role-based implementation. The [shared size scale
proposal](../../proposed/architecture/2026-11-20-web-font-size-scale.md) keeps the
single owner and changes how consumers select a size. The [migration policy](2026-11-20-web-typography-migration-policy.md)
introduces its six numeric definitions and equal transitional role mappings.

## Decision

The Web entry stylesheet loads six shared size values and transitional roles defined in
[typography.css](../../../../packages/daynight-web/src/styles/typography.css).
The browser sets the root size. The body and migrated shell and selection
controls use the `sm` size directly; remaining consumers use transitional roles.
Task filters and rows, personal
task groups, Goal summaries, task search, dependency
graphs, project overview, statistics, Worker pages and configuration, Worker
Prompt editors, usage panels, project settings, teams, GitHub integration, pull
requests, Webhooks, and Session controls and timeline details use semantic roles
at all viewport widths. Selection text retains the existing touch conditions and
a 16 CSS px minimum except for the narrow fine-pointer task filters described in
the later [filter font decision](../bug-fix/2026-11-20-project-task-filter-font.md);
count badges select `xs` directly. Shared Markdown selects magnitude-based sizes
under the [Markdown and Mermaid decision](2026-11-20-markdown-mermaid-typography.md);
Bot first-paragraph emphasis retains its weight without a separate size.
Touch fields, including Step title and Markdown editors
on coarse pointers, use the shared `--text-touch-field` size to preserve a 16 CSS
px minimum while responding to larger browser font preferences.
Terminal recordings use a shared `--text-terminal` base, multiplied by their
independent zoom scale; reading-role changes do not affect terminal output.

Business states, errors, controls, tool paths, and code use the interface role;
IDs, times, versions, and secondary counts use metadata. The [ordinary Task row decision](../bug-fix/2026-11-20-task-row-metadata-size.md) assigns its secondary badges and status text to metadata while preserving other status contexts. The [claim phase decision](../bug-fix/2026-11-20-task-claim-phase-size.md) assigns the read-only execution phase badge in Task details to metadata. The [machine record decision](../bug-fix/2026-11-20-task-row-machine-size.md) assigns ordinary row Worker records to metadata. Shared forms, Portal
dialogs, account notices, attachment controls, Goal details and Bot management
use the same roles. Superseded fixed declarations are removed or mapped to their
semantic role, so later overrides cannot conceal a competing size definition.
Narrow layouts wrap and rearrange controls, while dense panels retain local
scrolling where needed. Webhook detail tabs use a locally scrollable single row
with selected-item visibility, as defined by the later
[detail-tab decision](../bug-fix/2026-11-20-webhook-detail-tabs.md), so increased
browser fonts do not hide navigation. Graph layout coordinates grow
with the root font size so node boxes accommodate text independently of graph
zoom. The later [compact card decision](../bug-fix/2026-11-20-compact-graph-cards.md)
reduces the base geometry while retaining that scaling. Overview progress rows
rearrange at narrow widths; chart axes preserve horizontal scrolling and provide
room for enlarged labels.

Public landing and Setup pages, and standalone login, invitation, device
authorization and OAuth consent pages, use the semantic roles at all viewport
widths. Public reading copy and demo prose use the reading role; commands,
status, errors and actions use the interface role. Authorization codes use the
detail heading role, with the input using the section heading role. Account
actions and command copying reflow to accommodate larger text. The public header
remains sticky only while it occupies at most half the viewport; larger headers
scroll with the document. Anchor clearance uses the measured sticky height and
responds to header content, font and viewport changes.

Fixed geometry that depended on the former 14px root is independent of that root;
text-related spacing remains relative. The earlier
[root-independent layout decision](2026-11-19-web-root-independent-layout.md)
records the preparatory changes.

The Web harness enforces size ownership using the existing CSS and TypeScript
parsers across the complete production source tree. The central stylesheet owns
size values and fixed transitional mappings. The migration policy replaces the
original selection-alias and typed Mermaid theme permissions with exact legacy
occurrences and counts. Mermaid now uses the measured-size adapter and its
restricted source contract. Strict checks reject local overrides, fixed font sizes,
numeric fallbacks, unknown aliases and invalid font shorthands, with source
locations; only recorded legacy occurrences retain transitional permission.
The [Web validation guide](../../../../packages/daynight-web/README.md#typography-validation)
describes checker coverage and static evaluation limits.

## Alternatives

**Keep a fixed root font size.** This would prevent the browser's default font
preference from controlling rem-based text and would retain the implicit link
between the root and unrelated geometry.

**Keep the smaller fixed graph cards.** Larger labels and actions would collide or
be clipped, especially when the browser font preference increases. Scaling the
node geometry costs canvas space and can reduce the initial zoom on narrow screens.

**Define sizes in each component.** This permits equal semantic roles to drift
and makes changing a reading size require edits across consumers.

**Exempt files or ignore declarations overridden by later rules.** A new
declaration could silently enter a supposedly migrated file, and cascade changes
could reactivate an obsolete constant. Inspecting all declarations keeps size
ownership independent of file identity and current selector precedence.

**Keep fixed public-header offsets.** Locale, identity notices and browser font
preferences can change header height independently of width breakpoints. A fixed
clearance can hide anchor targets, and a header taller than the viewport can
prevent access to the page. Measuring the header preserves semantic text sizes
while leaving room for content.

## Consequences

First-party consumers and the inherited interface baseline respond to browser
font preferences; fixed layouts retain their intended geometry. The harness
prevents production declarations from introducing another size owner. Its
static evaluation does not execute arbitrary runtime functions or dynamically
computed property names, and cannot prove browser geometry or correct semantic
role selection. Narrow layouts must accommodate text without reducing its role
size. Touch fields retain their minimum readable size even when the browser's
default font is smaller. Browser validation remains necessary for controls,
attachment panes and dialogs whose text grows under the shared roles.
