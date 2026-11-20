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

## Alternatives

**Use a separate descriptions table.** Descriptions have no independent
lifecycle; a separate table would add joins, write coordination and orphan
cleanup without providing a needed capability.

**Extend existing list responses.** Existing OAuth clients reject unknown
fields, and the PAT management list needs different expiry filtering. Separate
versions preserve existing clients and make the new field mandatory.

## Consequences

The new endpoints require a main-site session and explicit account binding for
writes. Concurrent edits may conflict and require a fresh read. Existing indexes
serve owner lists and primary keys serve edits; retained expired PATs increase
the new list's size. Deployments must check callback paths and preserve new
protocol support after consumers adopt it.
