# Agent Note: Project Task Tab Width

Status: implemented

## Problem

Equal-width category tabs on narrow screens divide English labels inside words
while shorter labels leave unused space. A desktop sidebar can produce the same
constrained content width even when the viewport is wider. Counts and keyboard
navigation must remain usable when the available space is exceptionally small.

## Decision

The category tabs use their own container width to select the compact layout.
Within it, natural label and count widths determine the flex allocation, with
min-content protecting complete words and the count. The tab strip scrolls when
those minimum widths cannot fit. Selection, focus and size changes reveal the
relevant tab by moving only the strip. The [Web design](../../../../docs/design/daynight-web.md)
owns the layout and interaction contract.

## Alternatives

**Equal-width tabs with arbitrary wrapping.** This splits recognizable words
even when another tab has room to spare.

**Use a viewport breakpoint.** A sidebar can narrow the content independently of
the viewport, leaving the same problem at desktop widths.

## Consequences

Labels can wrap at natural boundaries without shrinking the text or count.
Very narrow strips require horizontal scrolling; focused and selected tabs are
revealed without scrolling the surrounding page. Long translations and larger
browser fonts can increase tab height or require more scrolling.
