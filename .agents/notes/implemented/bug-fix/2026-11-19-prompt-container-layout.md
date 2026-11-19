# Agent Note: Prompt Layout Follows Available Content Width

Status: implemented

## Problem

At a 768px viewport, the site navigation and Project settings navigation leave
about 314px for the personal Prompt editor. Its viewport breakpoint still selects
two columns, leaving a 26px textarea and wrapping headings into single characters.
The user, Project and Worker entry points have different surrounding navigation,
so viewport width does not establish the editor's available space.

## Decision

The adopted layout contract requires a named inline-size container on the shared
editor's `.worker-prompt` wrapper. Its child layout must use one column at content
widths up to and including 620px and retain the editor and explanation columns
above that threshold. The host must size the outer element independently of the
child grid. Layout changes must preserve editor nodes, drafts, focus, selection,
preview and save behavior. The
[Web design](../../../../docs/design/daynight-web.md#个人-worker-prompt-编辑)
owns the confirmed mechanism; the
[layout specification](../../../../docs/spec/worker-prompt-layout.md)
owns its required behavior and implementation acceptance. Adoption of this
contract does not establish that a deployed frontend satisfies it.

## Alternatives

**Raise the viewport breakpoint.** A larger viewport threshold could cover this
Project page, but still couples the shared editor to each host's navigation widths
and may collapse two columns when another host has sufficient content space.

## Consequences

A conforming layout adapts all three entry points to their actual available width.
Narrow containers place explanations below the editor and therefore require more
vertical scrolling. The 620px boundary must be reconsidered if panel spacing or
column sizing changes. Browser geometry and interaction checks remain necessary
because DOM-only tests cannot exercise CSS container queries; verification must
cover the original constrained Project layout and both sides of the boundary.
