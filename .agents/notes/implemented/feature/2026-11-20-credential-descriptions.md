# Agent Note: Credential Descriptions

Status: implemented

## Problem

Owners need to distinguish credentials with the same name or client without
changing their security properties. Existing clients require their published
metadata representations and credential lifecycles to remain compatible.

## Decision

PAT and OAuth grant rows hold nullable descriptions with their existing owner and
deletion lifecycle. A shared rule validates single-line Unicode and normalizes
the value. Dedicated account APIs expose the field and use owner-scoped
compare-and-set updates. PAT creation commits its description with the token and
returns the secret only after confirmed commit. The [authentication design](../../../../docs/design/daynight-auth.md#主站-session-与-pat)
owns the protocol and transaction details.

The account page consumes PAT v2 and OAuth v3 metadata through strict parsers.
Shared description controls render literal single-line text and keep the edit
trigger beside the description or, when empty, the name. Focus restoration keeps
the credential target until its panel finishes reading or writing and the pencil
is enabled. A confirmed receipt may move the pencil before the write settles;
attempting focus during that interval would consume restoration on a disabled
control. Drafts and observed
values are keyed by credential within each identity-bound panel. Explicit
reconciliation obtains a new observation without replaying a write. Each panel
serializes full-list reads, mutations and publication so an older snapshot
cannot overwrite another record's confirmed edit. Field-specific receipts merge
only their authoritative data. Confirmed PAT creation publishes its one-time
secret before an independent list refresh; a refresh failure cannot turn that
creation into a retryable write. Account retention includes unresolved writes,
drafts and pending secrets across SPA navigation. The [Web design](../../../../docs/design/daynight-web.md#账户凭据描述)
owns the presentation and lifetime details.

## Alternatives

**Use a separate descriptions table.** Descriptions have no independent
lifecycle; a separate table would add joins, write coordination and orphan
cleanup without providing a needed capability.

**Extend existing list responses.** Existing OAuth clients reject unknown
fields, and the PAT management list needs different expiry filtering. Separate
versions preserve existing clients and make the new field mandatory.

**Use a list refresh as write confirmation.** A list cannot recover a lost
creation secret or prove which request committed. Keeping confirmed secrets
separate from refresh failures prevents duplicate issuance, and retaining drafts
until explicit reconciliation preserves the owner's next decision.

## Consequences

The new endpoints require a main-site session and explicit account binding for
writes. Concurrent edits may conflict and require a fresh read. Existing indexes
serve owner lists and primary keys serve edits; retained expired PATs increase
the new list's size. Deployments must check callback paths and preserve new
protocol support after consumers adopt it.
