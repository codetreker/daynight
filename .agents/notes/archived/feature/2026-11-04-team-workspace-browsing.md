# Agent Note: Team Workspace Browsing

Status: implemented

## Problem

A single all-accessible project directory cannot distinguish projects belonging
to the user's Teams from projects shared by outsiders. Browsing and creation
must agree on the selected Team without changing explicit project identities.

## Decision

The authenticated workspace selects a real Personal or ordinary Team, or the
separate shared-project scope. Team and shared routes use the existing project
directory provider for both sidebar and cards. Changing scope discards its
cursor and pending results; identity admission applies to each read. Project
creation captures the Team at dialog opening. Explicit Project and Task links
retain their identities. The [project navigation decision](2026-10-27-sidebar-project-navigation.md)
continues to own the shared directory and native link behavior.

## Alternatives

**Separate caches for each Team and the sidebar.** Independent directories can
show inconsistent pages or creation results and require invalidating multiple
owners. One scoped provider preserves the existing shared pagination owner.

## Consequences

Users can navigate Team and shared projects without mixing pagination scopes or
creating a project in a newly selected Team by accident. Switching scope starts
a fresh directory read. At this decision, selection lasted only for the current
workspace session; [browser Team preference](2026-11-04-browser-team-preference.md)
subsequently added account-scoped persistence.
