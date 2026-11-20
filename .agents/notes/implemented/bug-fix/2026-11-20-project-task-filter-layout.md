# Agent Note: Compact Project Task Filters

Status: implemented

## Problem

On narrow project task lists, separately labeled filters wrap into three or four
rows despite unused horizontal space. Their height pushes the first task farther
below the viewport, with different wrapping for languages and selected values.

## Decision

The ordinary project task toolbar uses its available content width to select a
two-column layout from 264 through 420px and a single column below that range.
The existing controls, order, interaction and accessible names remain intact;
labels for assignee, status and platform sit inside their controls. Tag chips and
feedback retain their own space. The [Web design](../../../../docs/design/daynight-web.md)
records the layout and its ownership.

## Alternatives

**Keep the wrapping row.** It preserves the controls but leaves substantial
unused space and up to four touch-height rows on a 320px English page.

**Use viewport breakpoints alone.** A desktop workspace sidebar can leave the
same narrow content width as a phone; viewport width would miss that case.

## Consequences

Default narrow toolbars take two touch-height rows without reducing text or hit
targets. Long selections may truncate visually while their accessible names remain
complete. Selected tags, errors and enlarged text can increase the height. Search
retains its independent toolbar layout and the existing menu positioning remains
responsible for visible-viewport constraints.
