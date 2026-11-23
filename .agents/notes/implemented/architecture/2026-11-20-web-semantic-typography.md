# Agent Note: Web Semantic Typography

Status: implemented

## Problem

Web pages use unrelated font sizes and reduce some text on narrow screens.
Reading, controls, and metadata need consistent roles, while browser font
preferences must remain effective without unexpectedly enlarging existing layouts.

This note records the role-based implementation. The [shared size scale](2026-11-20-web-font-size-scale.md)
retains the single owner and replaces purpose-based selection. The
[migration policy](2026-11-20-web-typography-migration-policy.md) records the
bounded transition between those decisions.

## Decision

The Web entry stylesheet loads the six shared sizes defined in
[typography.css](../../../../packages/daynight-web/src/styles/typography.css).
The browser sets the root size, and the body selects `sm`. Selection text retains
the existing touch conditions and a 16 CSS px minimum except for narrow
fine-pointer filters described in the [filter font decision](../bug-fix/2026-11-20-project-task-filter-font.md)
and ordinary project toolbars under the [toolbar size decision](../bug-fix/2026-11-20-project-task-filter-xs.md).
Ordinary toolbar labels, closed values and counts select `xs` with either pointer
type; other count badges also select `xs`. Shared Markdown selects magnitude-based sizes under the
[Markdown and Mermaid decision](2026-11-20-markdown-mermaid-typography.md).
Bot first-paragraph emphasis retains its weight without a separate size. Marked
text fields use shared responsive or coarse-pointer adjustments to preserve a
16 CSS px minimum under their respective conditions while responding to larger
browser font preferences. Terminal recordings select `sm`, multiplied by their
independent, unitless zoom scale; changing `base` does not affect terminal output.
The [Session and Bot typography decision](2026-11-20-session-bot-typography.md)
records terminal and input responsibilities.

The original role-based choices assigned business states, errors, controls, tool
paths and code to interface; IDs, times, versions and secondary counts to metadata.
Their equivalents select the corresponding public sizes. The [ordinary Task row decision](../bug-fix/2026-11-20-task-row-metadata-size.md)
assigns its secondary badges and status text to metadata while preserving other
status contexts. The [claim phase decision](../bug-fix/2026-11-20-task-claim-phase-size.md)
assigns the read-only execution phase badge in Task details to metadata. The
[machine record decision](../bug-fix/2026-11-20-task-row-machine-size.md) assigns
ordinary row Worker records to metadata. Shared forms, Portal dialogs, account
notices, attachment controls, Goal details and Bot management follow the same
scale. The [attachment sidebar decision](../bug-fix/2026-11-20-attachment-sidebar-typography.md)
sets the shared Task and Goal sidebar hierarchy. The checker inspects declarations even when later rules supersede them.
Narrow layouts wrap and rearrange controls, while dense panels retain local
scrolling where needed. Webhook detail tabs use a locally scrollable single row
with selected-item visibility, as defined by the [detail-tab decision](../bug-fix/2026-11-20-webhook-detail-tabs.md),
so increased browser fonts do not hide navigation. Graph layout coordinates grow
with the root font size so node boxes accommodate text independently of graph
zoom. The [compact card decision](../bug-fix/2026-11-20-compact-graph-cards.md)
reduces the base geometry while retaining that scaling. Overview progress rows
rearrange at narrow widths; chart axes preserve horizontal scrolling and provide
room for enlarged labels.

Public landing and Setup pages, and standalone login, invitation, device
authorization and OAuth consent pages, select public sizes at all viewport
widths. Public reading copy and the demo introduction use `base`; commands, status,
errors and actions use `sm`. Authorization codes use `xl`, with the input using
`lg`. Account actions and command copying reflow to accommodate larger text. The
public header remains sticky only while it occupies at most half the viewport;
larger headers scroll with the document. Anchor clearance uses the measured
sticky height and responds to header content, font and viewport changes.

Fixed geometry that depended on the former 14px root is independent of that root;
text-related spacing remains relative. The [root-independent layout decision](2026-11-19-web-root-independent-layout.md)
records the preparatory changes.

The Web harness enforces size ownership using CSS and TypeScript parsers across
the complete production source tree. The central stylesheet owns size values;
Mermaid uses the measured-size adapter and its restricted source contract. The
checker rejects local overrides, fixed font sizes, retired names, numeric fallbacks,
unknown aliases and invalid font shorthands with source locations. The
[Web validation guide](../../../../packages/daynight-web/README.md#typography-validation)
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
computed property names, and cannot prove browser geometry or correct size selection. Narrow layouts must accommodate text without reducing its selected
size. Touch fields retain their minimum readable size even when the browser's
default font is smaller. Browser validation remains necessary for controls,
attachment panes and dialogs whose text grows under the shared scale.
