# Agent Note: Webhook Management Denial Cleanup

Status: implemented

## Problem

A Team administrator may become a member between directory checks. A validated
forbidden secret read or configuration write then disproves the displayed
administrator authority, but retaining its URL, plaintext secret and editor until
another successful read continues disclosing privileged data. The member may
still read redacted configurations and their original operation receipts.

## Decision

Secret reads and management submissions feed validated server `403 forbidden`
errors into the existing Team restriction observation. The request's captured
owner and authorization key must still match the current view. The restriction
immediately invalidates administrator projections and cached reads, closes the
editor, clears secrets and refreshes the authoritative Team directory. An
unchanged administrator directory cannot restore the disproved authority; a new
membership identity or version can restore it.

Project eligibility refusal uses a separate machine code and preserves owner
authority, as defined by the [eligibility refusal decision](2026-11-08-webhook-project-eligibility-refusal.md).

Configuration and receipt read denial continue using the owner-denial observation.
Original confirmed receipts remain independent, and unknown operations retain
GET-only reconciliation. Malformed error responses remain ordinary recoverable
errors. The [browser management decision](../architecture/2026-11-08-webhook-web-management.md)
owns the surrounding scoped reads and fixed intents; the
[browser design](../../../../docs/design/webhook-web.md) owns their mechanisms.

## Alternatives

**Revoke all owner access after every forbidden response.** Management denial does
not prove loss of membership or redacted configuration and own-receipt access.
It would hide valid reads and confuse a downgrade with removal.

**Wait for a directory or configuration refresh before cleanup.** A blocked or
failed background read would leave privileged projections visible after the
service has already disproved administrator authority.

## Consequences

The UI removes sensitive values before directory recovery completes and can then
show valid member projections. Old responses cannot revoke restored authority or
another selected owner. The regression suite covers secret and PATCH denials,
malformed errors, delayed directory recovery and late owner/authorization responses.
Live service acceptance remains separate from deterministic browser-component
verification.
