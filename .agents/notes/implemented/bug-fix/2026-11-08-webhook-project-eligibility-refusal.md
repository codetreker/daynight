# Agent Note: Webhook Project Eligibility Refusal

Status: implemented

## Problem

A valid Team administrator can submit a retained subscription selection after
its Project moves out of the Team. Reporting this refusal with the same code as
lost owner management authority closes a valid draft, disables unrelated Team
management and rejects subsequent administrator projections. An unchanged
membership version cannot recover that restriction.

## Decision

Subscription planning reports `webhook_project_ineligible` when the current
Project cannot be enrolled, expanded, confirmed or enabled. The HTTP adapter
maps it to 403 and publishes only the code, generic status text and request ID.
The browser retains a rejected draft and its current owner authority, allowing
an explicit new decision without replaying the refused request.

If an authoritative Project-directory refresh removes a selected Project, the
create dialog retains a checked, removable option displaying only its original
ID, matching the subscription selector's unavailable-Project fallback. It keeps
the user's selection until explicitly removed without retaining the old Project
name or owner label. Name, URL and event choices remain intact; a corrected
submission omits the removed ID and prepares a new operation ID.

The [management denial decision](2026-11-08-webhook-management-denial.md) still
requires immediate privileged-data cleanup for validated `403 forbidden` errors.
That decision addressed confirmed administrator authority loss between directory
checks; its immediate cleanup remains necessary. Project eligibility is a
different refusal and does not change the owner or authorization-key fences.
The [management design](../../../../docs/design/webhook-management.md) owns the
service and HTTP distinction; the [browser design](../../../../docs/design/webhook-web.md)
owns publication and retained drafts.

## Alternatives

**Infer the refusal from the service message.** Messages are diagnostics, not a
machine contract, and may change without preserving authorization semantics.

**Restore authority after an unchanged administrator directory read.** That would
also restore genuinely disproved authority while a stale directory remains
unchanged, weakening the existing privacy guarantee.

## Consequences

All Project eligibility statuses share one refusal code without disclosing the
Project's private details. Owner management denial remains restrictive immediately.
No mutation effect or receipt is written for either refusal. Older services that
still conflate the codes retain their previous restrictive browser behavior;
correct classification requires the distinct server code.
