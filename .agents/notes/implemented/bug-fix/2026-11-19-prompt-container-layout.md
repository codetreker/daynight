# Agent Note: Prompt Layout Follows Available Content Width

Status: implemented

## Problem

At a 768px viewport, the site navigation and Project settings navigation leave
about 314px for the personal Prompt editor. Its viewport breakpoint still selects
two columns, leaving a 26px textarea and wrapping headings into single characters.
The user, Project and Worker entry points have different surrounding navigation,
so viewport width does not establish the editor's available space.

## Decision

The shared editor establishes a named inline-size container on `.worker-prompt`.
Its child layout uses one column at content widths up to and including 620px,
and retains the existing editor and explanation columns above that threshold.
The outer element remains sized by its host. CSS changes layout without replacing
editor nodes or changing draft, focus, preview or save behavior. The
[Web design](../../../../docs/design/daynight-web.md#个人-worker-prompt-编辑)
owns the component mechanism.

## Alternatives

**Raise the viewport breakpoint.** A larger viewport threshold could cover this
Project page, but still couples the shared editor to each host's navigation widths
and may collapse two columns when another host has sufficient content space.

## Consequences

All three entry points adapt to their actual available width. Narrow containers
place explanations below the editor and therefore require more vertical scrolling.
The 620px boundary must be reconsidered if panel spacing or column sizing changes;
browser geometry and interaction checks remain necessary because DOM-only tests
cannot exercise CSS container queries.
