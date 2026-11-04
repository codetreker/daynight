# Agent Note: Browser Team Preference

Status: implemented

## Problem

Returning users need their Team workspace restored without applying another
account's choice or mistaking a transient failure for lost access. Explicit
Project and Task links must retain their resource identities.

## Decision

The browser stores only the selected Team UUID under an origin-local,
user-specific key. The default workspace uses Personal when no selection exists;
otherwise it validates the remembered UUID with an exact Team read. A confirmed
404 clears that user's selection and returns to Personal. Read failures remain
retryable without changing the saved selection; a failed write leaves the
current choice usable and reports that it was not saved. Shared projects do not
represent a Team selection. CLI defaults are independently owned.

This extends the [Team workspace browsing decision](2026-11-04-team-workspace-browsing.md),
which owns scoped project pagination and creation context.

## Alternatives

**Infer access from the Team picker.** The picker is paginated, so absence from
its loaded pages cannot establish that the account has lost access. An exact
read validates the remembered identity without enumerating all pages.

## Consequences

The preference is local to one origin and account, and does not grant access or
follow the user across devices. Recovery needs an additional Team read when a
selection exists. Storage and network failures remain visible and retryable;
identity and request lifetime checks keep late results from crossing accounts.
