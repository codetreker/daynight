# Agent Note: Sidebar Navigation Scopes

Status: implemented

## Problem

A sidebar that mixes Team, account and tool entries obscures which resources the
Team selector affects. Calling every project list "My projects" also suggests an
account scope for an ordinary Team, while a direct Project can belong to a
scope other than the selected sidebar Team.

## Decision

The sidebar groups the current Team or Personal space, My, and Tools in one
scrolling navigation. A type label distinguishes the selected scope, and project
lists use the neutral Projects title with the confirmed scope separately. Direct
Project breadcrumbs do not infer ownership from the sidebar. Account and tool
entries retain their own resource scopes; Webhooks keeps its independent owner
selection and catalog gate.

`WorkspaceSidebar` owns layout and drawer lifecycle, `WorkspaceNavigation`
composes the fixed routes and derives their active state, and
`SidebarProjectList` consumes the current Team project directory, shared with the
Team project cards. The [directory isolation decision](../bug-fix/2026-11-14-shared-project-directory-isolation.md)
keeps that directory visible on Shared with me and gives the shared page its own
owner. A required context distinguishes the ready Team ID used to generate links from the
visibility identity retained during a recheck. The [Personal visibility
rule](../feature/2026-11-05-personal-team-sidebar.md) and [Team selector
popover](../feature/2026-11-05-team-switcher-popover.md) remain in force.

## Alternatives

**Keep all navigation in one component.** This would leave route selection and
project-directory presentation coupled to drawer and focus lifecycle.

**Introduce a generic navigation registry.** The fixed entries do not need a
schema, permission callback framework or a second source of navigation state.

## Consequences

The groups communicate resource scope without adding a workspace entity. The
shared page has an independent directory so its account scope cannot populate the
Team tree. The explicit context prevents a retained display identity from
authorizing Team links; an unknown selection retains disabled placeholders.
The shared scrolling region keeps every group reachable for long directories.
Native links, the existing provider lifetimes and responsive drawer behavior
remain necessary to preserve navigation and background recovery semantics.
