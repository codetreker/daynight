# Agent Note: Project workspace top spacing

Status: implemented

## Problem

The project task workspace reserves substantial vertical space in its global
topbar and between that bar and the project heading. This pushes the project
sections down even when the controls and navigation fit comfortably. The
project list and settings pages have separate layout responsibilities.

## Decision

`AuthenticatedApp` marks only the project task route with
`project-workspace-shell`. The authenticated shell stylesheet owns its topbar
minimum height and vertical padding, plus the content's top padding. Above
740px, these are 56px, 8px and 16px. At 740px or less, the existing sticky bar
keeps its natural height with 6px vertical padding and 12px content top padding.
The selector includes both shell classes so generic responsive padding rules
cannot override the project spacing.

The project stylesheet gives the navigation row above the heading a single
10px bottom margin at every width. The existing wrapping, return link and
conditional semantic refresh time retain their behavior. Controls, typography,
horizontal gutters, bottom padding and content centering keep their owners.
Actual notices and wrapped controls can still increase the topbar's height.

The [Web design](../../../../docs/design/daynight-web.md) owns the current
composition. The [heading spacing decision](2026-11-20-project-heading-spacing.md)
separately owns the gap below the project heading.

## Alternatives

**Change the generic topbar and content rules.** This would also change project
lists, settings and unrelated workspaces. A route-owned marker expresses the
required project scope without coupling those pages to the compact spacing.

**Fix the topbar height.** A fixed height would prevent long content, language
feedback and account notices from taking the space they need. Minimum height
and natural wrapping preserve the existing controls and touch targets.

## Consequences

Every project section shares the compact top spacing without changing component
identity or requesting additional data. Narrow screens preserve the 44px drawer
button and natural topbar growth. The route marker and spacing owners remain
explicit, so new project routes must deliberately select their layout.
