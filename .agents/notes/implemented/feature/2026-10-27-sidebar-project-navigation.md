# Agent Note: Shared Project Directory in Workspace Navigation

Status: implemented

## Problem

Switching projects requires returning to the project index before choosing a
project. Navigation also needs usable project names and selection while viewing
project members or settings, within the existing narrow sidebar and phone
navigation.

## Decision

My projects retains its index link and owns a nested list of project links.
Project, member and settings routes select their project; the index selects the
parent entry. Ordinary links preserve native modified navigation. Truncated
names retain full accessible names and hover titles.

One projects provider lives inside the authenticated Workspace lifetime. Sidebar
links and project cards consume its loaded pages, cursor, errors and actions.
The existing 50-item API pagination preserves server order and deduplicates IDs.
Both consumers can load more or retry. A continuation failure retains loaded
projects, while refresh invalidates old pages and pending responses. Creation
and removal of one's own membership refresh the directory. An identity change
releases the old directory and cancels its requests.

Project children appear in expanded desktop navigation and the mobile drawer.
The folded rail hides the children, avoiding indistinguishable project icons.
The [sidebar preference decision](2026-10-25-sidebar-preference.md) continues to
own widths, desktop persistence and temporary phone navigation. Project links
share its scrollable upper region and existing navigation and focus handling.

## Alternatives

**Fetch independently for the sidebar and index.** Separate hook instances
request the same first page twice and can disagree after pagination, creation or
membership removal. A shared provider keeps one authoritative loaded directory
without adding a query framework or persistence layer.

**Fetch every project before displaying navigation.** This delays usable links
until all pages arrive and makes partial failures harder to recover from.
Explicit Load more reuses the established project-list behavior and retains
already usable links after a continuation failure.

## Consequences

Users can switch directly from project pages while the existing index remains
available for repository details and project creation. Shared directory state
survives project navigation and resets with authenticated identity. Initial
reads now also occur when entering other Workspace routes, because their
navigation displays the directory. Sidebar width changes do not initiate reads.

The directory remains an in-memory paginated view, with the API's existing
cross-page consistency limits. It adds no background synchronization or total
project count. Long lists scroll above the reachable account and toggle footer.
