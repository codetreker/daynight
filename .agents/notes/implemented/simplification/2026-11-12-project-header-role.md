# Agent Note: Project Header Role Display

Status: implemented

## Problem

The project header placed the current visitor's effective role alongside its
actions. The label occupied space without identifying project administrators;
the members page already provides the role and its source.

## Decision

The shared project header displays the members and settings links without a
current-user role badge. Until the independent Project read supplies the links,
the header reserves their localized geometry outside the accessibility tree.
The members page retains effective roles, their sources and permission controls.
The [project read decision](../architecture/2026-11-13-project-page-independent-read.md)
records its separate admission and withdrawal boundary.

The [earlier header decision](../../archived/bug-fix/2026-10-23-project-header-layout-shift.md)
records why asynchronous access must not move restored content. Its role-width
reservation is superseded by the link-only geometry.

## Alternatives

**Keep the role badge.** It repeats information available in the members page
and occupies the primary action area without listing administrators.

**Hide only the badge text.** Retaining its measurement or width reservation
would leave unused space and unnecessarily constrain long project titles.

## Consequences

Admin and member headers use the same action geometry in both languages.
The link reservation preserves title wrapping and restored scroll position
without reserving role width. Users consult the members page for role details.
