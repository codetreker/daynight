# Agent Note: Personal Team Sidebar Navigation

Status: implemented

## Problem

Personal Teams have fixed membership and read-only settings, so their member and
settings entries add navigation noise while ordinary Teams still need management
links. The workspace must distinguish Team identity without changing direct
resource access or sending links to an initial Personal selection while a saved
selection is being restored.

## Decision

The workspace sidebar omits its Team settings entry when the confirmed selected
Team ID matches the authenticated user's Personal Team ID. Ordinary Teams retain
their Team settings link, including when their names resemble Personal. The
[settings sections decision](2026-11-10-team-settings-sections.md) groups the roster
and invitations within that page; the original Personal visibility rule applies
to its single sidebar entry. The same rendering applies to desktop and narrow
navigation. During a same-navigation background recheck, the last verified
identity is retained only for visibility, avoiding a temporary reappearance of
the omitted entry. Links still require a ready selection, so recovery cannot
navigate to the initial Personal ID. Direct Personal member and settings routes
and their access rules remain available.

The [browser Team preference decision](../../archived/feature/2026-11-04-browser-team-preference.md)
records the rationale for the existing selection restoration, account isolation
and retry behavior.

The [sidebar scopes decision](../architecture/2026-11-12-sidebar-navigation-scopes.md)
organizes this behavior within the current scope group.

## Alternatives

**Use the displayed Team name to identify Personal.** Ordinary Teams may have
identical names, so this would hide their management links and could vary with
localization.

**Hide the entries only visually.** Retaining links in the document risks
leaving keyboard or accessibility entry points and layout gaps. Conditional
rendering removes the complete entries when Personal is confirmed.

## Consequences

Personal navigation contains fewer irrelevant controls, while changing Teams
restores the ordinary management entry without affecting other workspace pages.
The sidebar depends on the authenticated Personal ID and the existing confirmed
selection; direct URLs remain valid and service-side authorization remains the
final authority.
