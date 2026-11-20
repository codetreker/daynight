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
requests, Webhooks, and Session controls and timeline details use semantic roles
at all viewport widths. Selection text retains the existing touch conditions and
a 16 CSS px minimum; count badges use the metadata role. Markdown code and tables
use the interface role; Bot first-paragraph emphasis retains its weight without a
separate size. The [UI standard](../../../../docs/ui-design.md#web-typography)
owns role uses and sizes. Touch fields, including Step title and Markdown editors
on coarse pointers, use the shared `--text-touch-field` size to preserve a 16 CSS
px minimum while responding to larger browser font preferences.
Terminal recordings use a shared `--text-terminal` base, multiplied by their
independent zoom scale; reading-role changes do not affect terminal output.

Business states, errors, controls, tool paths, and code use the interface role;
IDs, times, versions, and secondary counts use metadata. Shared forms, Portal
dialogs, account notices, attachment controls, Goal details and Bot management
use the same roles. Superseded fixed declarations are removed or mapped to their
semantic role, so later overrides cannot conceal a competing size definition.
Narrow layouts wrap and rearrange controls, while dense panels retain local
scrolling where needed. Webhook detail tabs use a locally scrollable single row
with selected-item visibility, as defined by the later
[detail-tab decision](../bug-fix/2026-11-20-webhook-detail-tabs.md), so increased
browser fonts do not hide navigation. Graph layout coordinates grow
with the root font size so fixed node boxes accommodate text independently of
graph zoom. Overview progress rows rearrange at narrow widths; chart axes preserve
horizontal scrolling and provide room for enlarged labels.

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
role values; the shared selection components own their registered size aliases.
The checker rejects local role overrides, fixed font sizes, numeric fallbacks,
unknown aliases and invalid font shorthands, with source locations. Terminal
base-size multiplication and typed Mermaid theme configuration are rendering
mechanisms with explicit rules; their files remain subject to normal checks.
The [UI standard](../../../../docs/ui-design.md#web-typography) owns the exact
exceptions and static evaluation limits.

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
