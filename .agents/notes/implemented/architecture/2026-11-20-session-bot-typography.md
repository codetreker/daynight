# Agent Note: Session and Bot Typography

Status: implemented

## Problem

Session timelines, terminal recordings and Bot workspaces combine long-running
reading with dense controls, tool names, metadata and editable forms. Their
purpose-based size references obscure which shared size a consumer actually
selects. Terminal zoom and touch input adjustments also need clear owners so
changes to surrounding text cannot change playback scale or hide form controls.

## Decision

Session, Test Session, Bot and Assistant Task consumers select the public sizes
defined by [typography.css](../../../../packages/daynight-web/src/styles/typography.css).
The [shared size scale](2026-11-20-web-font-size-scale.md) applies across the
production source tree. This decision replaces the terminal base
selection in the [semantic typography decision](2026-11-20-web-semantic-typography.md)
without changing the original role mappings preserved there as history.

Terminal output directly uses `sm` multiplied by the existing unitless
`--terminal-text-scale`. The recording component owns that user-selected
percentage; the output renderer owns the shared base selection. Selecting
`sm` gives terminal text the same ordinary reading size as Session text while
preserving independent user zoom. Surrounding actions, states and errors use
`sm`; time and the first caption column use `xs`. Changing `base` does not
resize output, and terminal zoom does not resize surrounding UI.

Shared Markdown owns its `sm` body size in Session and Bot hosts. Host styling
retains color, spacing and emphasis without repeating that size. Native proposal
headings select `base` at the top level and inherit ordinary text internally;
Markdown headings retain the shared renderer's own selection. Bot details
auxiliary text selects `xs`, while list counts inherit their `lg` heading.

Session composer and custom interaction text fields opt into the shared
coarse-pointer adjustment. Multiple-choice labels carry that adjustment and
their text inherits it; checkbox and radio controls retain their existing rules.
Bot creation and directory text inputs use the responsive adjustment at narrow
widths or on coarse pointers. Ordinary input sizes inherit from their selected
container, and local font-size overrides are removed so the shared adjustment
can enforce its browser-relative size and 16 CSS px minimum. Existing hit areas,
form state, directory navigation and draft ownership remain with their consumers.

## Alternatives

**Keep terminal output at the former `xs` base.** This would retain smaller
recorded text than ordinary Session reading. A direct `sm` selection supplies
the ordinary reading size while keeping user zoom available for denser output.

**Keep local touch font rules.** Repeated adjustments compete through selector
specificity, including the Bot name input's ID selector. Shared opt-in rules
provide one minimum and browser-font behavior while each feature retains its
existing control geometry.

## Consequences

Terminal text grows from 12 to 14 CSS px at a 16px browser root before user zoom.
Playback frames may require more horizontal scrolling; their content, timing and
zoom persistence are unchanged. Shared `sm` changes affect terminal output at
the same user multiplier, while `base` changes affect marked touch inputs
without changing terminal output.

The [Web validation guide](../../../../packages/daynight-web/README.md#typography-validation)
owns commands and static-analysis limits. Browser checks measure actual Session,
terminal and Bot text with altered roots, user zoom and narrow or coarse-pointer
layouts. Static ownership checks cannot establish clipping, focus, selection,
draft continuity or directory reachability.
