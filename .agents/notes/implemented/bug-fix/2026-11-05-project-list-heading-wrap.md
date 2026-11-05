# Agent Note: Project List Heading Wrapping

Status: implemented

## Problem

On narrow project lists, the nonshrinking action group leaves almost no width
for the heading and subtitle. Long-word wrapping then breaks even Personal into
a tall column despite the page having no horizontal overflow. Personal, Team
and Shared lists share this heading, independently of their data state.

## Decision

`ProjectsPage` has a dedicated `project-list-heading` class that allows flex
wrapping. Its `project-list-information` child uses `flex: 1 1 240px`: it fills
the available row when the action group cannot fit beside its basis. The action
group keeps its existing sizing and uses an automatic left margin to align to
the right when it wraps. DOM order remains information, create when permitted,
then refresh.

The [Web design](../../../../docs/design/daynight-web.md#team-管理与共享项目列表)
owns the current page behavior. Global heading rules and long-name wrapping
remain available to other pages.

## Alternatives

**Change all page headings.** Worker and project-detail pages have their own
responsive rules. A global wrapping change would affect unrelated layouts.

**Remove long-word wrapping.** This hides the compression symptom by allowing
long names to overflow; it does not reserve readable space for the information.

## Consequences

At 320 and 390 CSS pixels, information occupies the content width and actions
follow on a separate row. Wider content can keep both groups on one row. The
transition follows available content width, including sidebar width, rather
than a device-specific media query. Fonts, controls, requests and dialog focus
behavior remain owned by their existing components.

Layout validation must compare information and action rectangles, title line
height, button bounds and overlap in both languages and all list scopes and
states. A scroll-width check alone misses the original failure. Browser input
checks cover keyboard order, pointer activation and dialog focus restoration;
controlled API responses exercise UI states without proving server behavior.
