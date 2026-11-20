# Agent Note: Project heading spacing ownership

Status: implemented

## Problem

The shared project heading carries both `page-heading` and `project-heading`.
The generic heading stylesheet loads after the project stylesheet, so its
equally specific bottom margin overrides the project's zero margin. Together
with the project layout's 26px top margin, this leaves 52px on desktop and
48px at widths of 600px or less between the heading and section navigation.

## Decision

The project stylesheet uses `.page-heading.project-heading` to set the heading's
bottom margin to zero. The project layout alone owns the 26px separation on
desktop and mobile. Generic headings, stylesheet import order, responsive
alignment and section structure retain their existing responsibilities.

Real project-information errors keep their position between the heading and
layout and occupy their normal space. The [Web design](../../../../docs/design/daynight-web.md)
owns the current layout mechanism.

## Alternatives

**Reorder stylesheets.** Making the project stylesheet load last could restore
the equal-specificity override, but changes cascade ordering for unrelated
application and feature styles. An explicit project selector expresses the
local spacing ownership without that broader dependency.

## Consequences

Project sections share one spacing source across responsive layouts. A
production-build browser regression measures the heading and layout edges,
including the mobile horizontal navigation, so future generic heading changes
cannot silently restore the duplicated gap. Error-state checks preserve the
additional space required by actual error messages.
