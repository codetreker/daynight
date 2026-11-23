# Agent Note: Credential Scope Activation

Status: implemented

## Problem

Independently prepared permission checks cannot protect credentials while a
production entry still uses unrestricted authentication or a delayed operation
reuses stale authority. Existing credentials and approved authorizations must
retain their operations when explicit permissions become mandatory, without
acquiring future permissions automatically.

## Decision

Production composes scoped authentication, business services, REST and MCP
registrations and the matching Web authorization and management pages together.
Current-policy readers preserve the original principal and profile and bind
existing transactional rechecks to the owning transaction. Locking admission
checks expiry using the database clock after the credential lock is acquired.
Task observation and Sync publication rechecks refresh the original policy in
their final snapshot, including permissions used for sampled Session projections. Fixed browser, API
OAuth and internal profiles keep their original protocol restrictions.

Migration 111 contains explicit, sorted permission ID arrays for PAT and MCP.
It fills missing legacy credential policies and approved authorizations with
their type's complete activation-time set and version 1. Pending requests still
require a new explicit decision; existing explicit policies remain unchanged.
The migration does not apply new-issuance defaults or deployment availability
filters to historical credentials. PAT policy columns are mandatory without a
default, so an obsolete writer fails visibly.

Old writers and connections must drain before migration. A paired recovery point
precedes the cutover. A committed migration ledger prevents starting an older
artifact even when the candidate failed before serving traffic. Unknown commit
results require ledger, checksum and schema observation while traffic remains
drained. Restoring an old artifact requires the matching pre-migration database
and confirmation that no post-migration business writes need preserving;
otherwise recovery uses a build that understands the current ledger and policies.

The [scope contract](2026-11-20-credential-scope-contract.md) owns the shared
permission model; the [design](../../../../docs/design/credential-scope-internal.md)
owns admission, assembly and recovery details.

## Alternatives

**Infer full access from a missing policy.** That would let old writers and
incomplete authentication silently bypass scope checks after activation.
Explicit migration makes the historical grant auditable and rejects missing facts.

**Use current catalog defaults during backfill.** Team and MCP Worker defaults
deliberately restrict new grants. Applying them to old credentials would remove
existing abilities; recalculating the set on later startups would also grant new
abilities without consent. Frozen migration literals preserve both boundaries.

**Activate individual protocol paths separately.** A reduced credential could
reach an unrestricted sibling path or old process. Coordinated Server/Web
activation and complete registration classification preserve one policy across
the public entry points.

## Consequences

Existing secrets, expiry, revocation, OAuth protocol scopes, resource bindings
and one-time redemption semantics remain intact. New issuance and editing use
explicit nonempty selections. Authentication and transactional policy reads add
no scope indexes or foreign keys. A deployment needs a measured drain and
migration window plus a usable paired recovery point. Isolated upgrade and
startup evidence establishes candidate behavior; production switching and
publication retain their separate authorization.
