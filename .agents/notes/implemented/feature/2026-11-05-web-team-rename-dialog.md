# Agent Note: Web Team Rename Dialog

Status: implemented

## Problem

Team settings present immutable identity and the saved name alongside an always
editable field. This obscures the distinction between reading information and
deliberately changing it.

## Decision

Settings show the Team ID and saved name as selectable text. An ordinary Team
admin opens a `ManagementDialog` to edit the name; members and Personal Team
users remain read-only. The dialog initializes from the saved name, and its
cancel and close actions do not submit. The existing identity, version, conflict
and unknown-write protections remain owned by
[Team management](2026-11-04-web-team-management.md).

## Alternatives

**Keep the inline form.** It avoids opening a dialog but presents the saved name
as an active input even when the user only wants to inspect the Team.

## Consequences

Editing is explicit and uses the existing dialog's focus and keyboard behavior.
The operation state outlives dialog visibility, so closing and reopening it does
not permit an unconfirmed write to be repeated.
