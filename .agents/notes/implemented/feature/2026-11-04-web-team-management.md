# Agent Note: Web Team Management

Status: implemented

## Problem

Team members need to inspect their Team identity and administrators need to
manage ordinary Teams without confusing a rejected or uncertain write with a
completed operation. Names and versions can change concurrently, and browser
text controls normalize line endings.

## Decision

The Team selector opens creation and the workspace exposes a settings route.
Settings read the actual Team and version; ordinary Team admins can rename or
request deletion, while members and Personal Team users have read-only settings.
Deletion requires manually entering the current name and sends the original name
and precise version. Creation uses direct form submission; the
[rename dialog decision](2026-11-05-web-team-rename-dialog.md) owns the settings
editing interaction. Identity admission and response validation bind each
mutation to its actor; uncertain
writes remain unknown and offer reads without replay. Successful creation and
deletion navigate through the existing account-scoped Team preference.
Settings retain their loaded content, draft, confirmation and operation result throughout same-user
identity checks and background reads. Initial loads and explicit reconciliation have distinct purposes; a Team read cannot replace a pending or unknown mutation result or authorize replay.

## Alternatives

**Use the paginated Team selector as the settings source.** Its loaded page may
be incomplete and its snapshot can be stale. An exact Team read supplies the
current identity, role, name and version for management.

## Consequences

Users can review current facts after a conflict or an unknown outcome without
claiming that a read recovered a lost receipt. The extra Team read before
deletion protects confirmation against stale names; server version checks still
resolve concurrent changes. Browser preference storage failures remain visible
and retryable under the [preference decision](2026-11-04-browser-team-preference.md).
