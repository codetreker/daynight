# Agent Note: Shared Project Directory Isolation

Status: implemented

## Problem

Opening Shared with me removed the current Team's project navigation. The Team
and shared project lists have different scopes, yet both used one directory
whose scope changed with the route. Reusing the shared results in the Team tree
would misidentify their ownership, and changing scope also discarded the Team's
loaded pages and cursor.

## Decision

The workspace retains a Team-scoped directory for the sidebar and Team project
cards. Shared with me mounts a separate shared-scoped directory for its body,
independent of Team preference restoration. Both use the existing pagination,
admission, cancellation and identity isolation mechanisms. Workspace mutation
callbacks refresh the current Team directory and the mounted shared directory;
the shared page registers its current refresh callback and unregisters it when
it changes or unmounts. Navigation remains governed by the original operation's
context, including for a late transfer receipt.

The [sidebar scopes decision](../architecture/2026-11-12-sidebar-navigation-scopes.md)
retains the navigation groups and Team visibility rules. The
[Web design](../../../../docs/design/daynight-web.md#team-管理与共享项目列表)
owns the current directory and refresh responsibilities.

## Alternatives

**Only show the existing tree on the shared route.** The route-scoped provider
would feed shared projects into the current Team tree, and entering the route
would still discard its loaded Team pages.

**Keep hiding the Team tree on the shared route.** This avoids presenting shared
projects as Team projects but removes useful Team navigation and loses the loaded
Team directory on scope changes.

## Consequences

The Team directory and its loaded prefix survive ordinary navigation into and out
of Shared with me; each scope has independent requests, pagination and errors.
A mounted shared page incurs its own request and refresh work, necessary to keep
its account scope separate. Actual Team or identity changes and access revocation
retain their existing isolation and cleanup behavior.
