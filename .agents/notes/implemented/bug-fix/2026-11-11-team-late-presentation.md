# Agent Note: Team Late Presentation Ownership

Status: implemented

## Problem

Team creation, rename and deletion can finish after the user has left the
submission context. A valid receipt still describes a real resource change,
but its old presentation effects can close a retained editor, clear its draft
or redirect a user who has since navigated elsewhere and returned.

## Decision

The Team forms capture their editor identity, in-memory draft revision and the
admitted navigation snapshot at submission. Successful results retain the
existing identity and admission checks and publish resource facts. Destructive
editor cleanup and automatic navigation require the captured presentation
context to remain current. The original delivery retained the operation owner's
pending and promise timing; the [local settlement decision](2026-11-12-team-operation-local-settlement.md)
subsequently separated that timing from publication. The [authentication design](../../../../docs/design/daynight-auth.md)
describes the resulting Team behavior.

## Alternatives

**Compare the current URL.** A user can leave and return to the same URL or a
different history entry, so equality does not preserve their navigation choice.

**Suppress the entire late success.** This would discard confirmed Team facts
and deletion receipts even though only the presentation context changed.

## Consequences

An old success can leave its original form open when navigation has changed;
the user retains the draft and can close it. Confirmed creation and deletion
remain visible and cannot be resubmitted as the same operation. The revision is local to the editor
and does not change persistence. Other operation consumers retain their own
presentation rules. The
[stable Team checks decision](2026-11-05-stable-team-checks.md) continues to
govern resource version reconciliation and admission.
