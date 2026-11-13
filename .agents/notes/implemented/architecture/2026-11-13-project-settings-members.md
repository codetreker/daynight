# Agent Note: Members in the Project Settings Workspace

Status: implemented

## Problem

Members and invitations need to be discoverable from the same project settings
entry as other configuration. Their authorization, one-time secrets and outcomes
have independent lifetimes, including a confirmed loss of the actor's own access
while another settings section is visible.

## Decision

The existing member controller belongs to the stable user and Project settings
workspace. The legacy members URL selects its section directly. Member and
invitation operations retain their independent permission and repeat-prevention
rules; their retention includes an already displayed secret and per-invitation
outcomes. A stable result host outside the private unavailable area publishes the
existing non-secret receipt or held result for its original actor and workspace.
The [requirements](../../../../docs/spec/project-settings.md) and
[design](../../../../docs/design/project-settings.md) own the current behavior and
boundaries. This extends the [settings workspace decision](2026-11-13-project-settings-workspace.md).

## Alternatives

**Keep a separate member host beside the settings host.** It would retain two
owners for one visible workspace, making section changes look like leaving the
member page and splitting secret, result and authorization lifetimes.

**Move only the navigation and defer result and secret integration.** The new
section could hide or unload a revealed link and delay a self-loss receipt, while
other settings sections continued to display private data. Routing and lifecycle
integration therefore ship together.

## Consequences

Members use one management entry without changing direct grants, inherited Team
access or invitation semantics. Retaining a member controller across temporary
navigation costs memory until its protected result and repeat-prevention facts
are resolved. Security effects still follow the original receipt even when the
section is hidden; presentation also checks the original location and generation.
