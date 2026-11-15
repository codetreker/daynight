# Agent Note: Standalone Row Container Width

Status: implemented

## Problem

Expanded workspace and project navigation leave narrow task lists in tablet and
split desktop windows. Standalone rows keep the badge group at its full inline
width, squeezing task titles and IDs into nearly vertical text. A page can have
no horizontal overflow while its titles are unreadable.

## Decision

The standalone list established a named inline-size container. At widths of
650px or less, rows used mobile spacing, vertical right-aligned badges, smaller
metadata and a hidden chevron; wider lists retained inline badges. The title
stayed flexible without a fixed minimum that could overflow phones.

The initial 600px reference leaves a roughly 604px list in a 1000px expanded
window. Long English badges, including Paused, still squeeze its title below
200px. The 650px threshold covers this case and the collapsed 900px layout while
keeping the expanded 1100px layout horizontal.

The [compact list decision](../../archived/simplification/2026-10-28-compact-task-list.md)
records the analogous chain-row container layout. The later [shared Task row
decision](../architecture/2026-11-15-shared-project-task-row.md) unifies the
ordinary row presentation across project lists while retaining their owners.
The [Web specification](../../../../docs/spec/daynight-web.md) owns required
behavior and the [Web design](../../../../docs/design/daynight-web.md) describes
composition.

## Alternatives

**Increase the viewport breakpoint.** Viewport width does not account for
expanded navigation. A breakpoint that helps the expanded sidebar would also
compact lists with ample space after the sidebar collapses.

**Force a 200px title minimum.** This prevents compression in tablet windows but
can overflow a 320px phone once the existing sidebar and badges are included.

## Consequences

Titles retain usable space as navigation changes the list width. Badge text is
preserved, including longer English permission labels and paused or blocked
states. Phones retain the same row layout, and wide lists retain inline badges.
Browser acceptance measures title geometry in addition to document overflow,
checks both languages and sidebar states, and verifies keyboard focus and detail
opening. The existing narrow-layout acceptance journey owns the regression.
